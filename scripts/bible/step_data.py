"""STEPBible data (github.com/STEPBible/STEPBible-Data, CC BY 4.0): the Hebrew
OT (TAHOT) and Greek NT (TAGNT) word by word, the brief lexicons of extended
Strong's numbers (TBESH, TBESG) and the morphology code expansions (TEHMC,
TEGMC). Parsing follows the rules in each file's own header; the Greek text
shown is NA28's.
"""
import re
import unicodedata

from books import BY_STEP, format_ref, verse_id
from translit import latinize

DATA_ROW = re.compile(r"^([1-3A-Z][a-zA-Z]{2})\.(\d+)\.(\d+)")
TAHOT_REF = re.compile(r"^(\w{3})\.(\d+)\.(\d+)(?:\((\d+)\.(\d+)\))?#(\d+)=(.+)$")


def _lines(path):
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            yield line.rstrip("\n")


# --- Morphology ---

_ABBREV = {
    "First": "1st", "Second": "2nd", "Third": "3rd", "1st": "1st", "2nd": "2nd", "3rd": "3rd",
    "Masculine": "masc.", "Feminine": "fem.", "Neuter": "neut.", "Either gender": "common", "Common gender": "common",
    "Both": "common", "Singular": "sing.", "Plural": "pl.", "Dual": "dual",
}
# Field values that add nothing in a short label.
_QUIET = {("Form", "Common"), ("State", "Absolute"), ("Type", "Common")}


def _short_label(fields):
    """'Verb Qal Perfect 3rd masc. sing.' from line 1's Function=...; Stem=...; ... fields."""
    parts = []
    person = gender = number = ""
    for key, value in fields:
        if (key, value) in _QUIET or not value:
            continue
        if key == "Person":
            person = _ABBREV.get(value, value)
        elif key == "Gender":
            gender = _ABBREV.get(value, value)
        elif key == "Number":
            number = _ABBREV.get(value, value)
        else:
            parts.append(value)
    pgn = " ".join(p for p in (person, gender, number) if p)
    return " ".join(parts + ([pgn] if pgn else []))


def read_morph(path):
    """{code: (short, label, explanation)} from a TEHMC/TEGMC file's $-separated records."""
    codes = {}
    current = None
    lines = []

    def flush():
        if current and lines:
            first = re.sub(r"\(hence[^)]*\)", "", lines[0])
            fields = []
            for item in first.split(";"):
                if "=" in item:
                    key, value = item.split("=", 1)
                    fields.append((key.strip(), value.strip()))
            label = lines[1].strip().strip('"').strip() if len(lines) > 1 else ""
            explanation = lines[2].strip().strip('"').strip() if len(lines) > 2 else ""
            codes[current] = (_short_label(fields), label.replace(" : ", " "), explanation)

    for line in _lines(path):
        if line.startswith("$"):
            flush()
            current, lines = None, []
            continue
        if current is None and line and not line.startswith("\t") and "\t" in line and "=" in line.split("\t", 1)[1]:
            current = line.split("\t", 1)[0]
            lines = [line.split("\t", 1)[1].strip()]
            continue
        if current and line.startswith("\t"):
            lines.append(line.strip())
    flush()
    return codes


# --- Lexicons ---

POS_WORDS = {
    "V": "verb", "N": "noun", "A": "adjective", "Adv": "adverb", "Prep": "preposition", "Conj": "conjunction",
    "Prt": "particle", "Part": "particle", "Pron": "pronoun", "Int": "interjection", "Intj": "interjection",
    "Art": "article", "T": "article", "P": "pronoun", "R": "pronoun", "Ptcl": "particle", "Cond": "conditional",
    "Prefix": "prefix", "Suffix": "suffix", "Punc": "punctuation",
}
POS_SUFFIX = {"M": "masculine", "F": "feminine", "N": "neuter", "P": "person", "L": "place", "T": "title", "G": "group"}


def pos_words(code):
    """'H:N-M' -> 'noun, masculine'; 'G:V' -> 'verb'."""
    body = code.split(":", 1)[-1]
    parts = [p for p in body.split("-") if p]
    if not parts:
        return code
    head = POS_WORDS.get(parts[0], parts[0].lower())
    tail = [POS_SUFFIX.get(p, p.lower()) for p in parts[1:]]
    if "person" in tail or "place" in tail:
        head = "name"
    return ", ".join([head] + [t for t in tail if t not in ("person",)])


def read_lexicon(path, prefix):
    """{dStrong: row} for TBESH ("H") or TBESG ("G"); row = the 8 columns."""
    rows = {}
    for line in _lines(path):
        if re.match(rf"^{prefix}\d", line):
            cols = line.split("\t")
            if len(cols) >= 8:
                rows[cols[1].split(" ")[0]] = cols
    return rows


def lexeme_of(dstrong, lexicon, prefix):
    """The lexicon entry a tag belongs to (TBESH/TBESG column 0), falling back to the bare number."""
    row = lexicon.get(dstrong)
    if row is None:
        number = re.match(rf"^({prefix}\d+)", dstrong)
        if not number:
            return dstrong
        row = next((r for key, r in lexicon.items() if key.startswith(number.group(1))), None)
        if row is None:
            return number.group(1)
    key = row[0].strip()
    return key[:1] + key[1:].upper() if prefix == "H" else key


def clean_html(html, refs_out=None):
    """Lexicon HTML to plain text with newlines; <ref='Mat.5.43'> links collected as (start, end, STEP ref)."""
    html = re.sub(r"<br\s*/?>|<BR\s*/?>", "\n", html)
    html = html.replace("__", "")
    text = ""
    pos = 0
    for m in re.finditer(r"<ref='([^']+)'>(.*?)</ref>|<[^>]+>", html, flags=re.S):
        text += html[pos:m.start()]
        if m.group(1):
            inner = re.sub(r"<[^>]+>", "", m.group(2)).rstrip(";, ")
            start = len(text)
            text += inner
            if refs_out is not None:
                refs_out.append((start, len(text), m.group(1)))
            text += m.group(2)[len(inner):] if m.group(2).startswith(inner) else ""
        pos = m.end()
    text += html[pos:]
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ")
    return text


def step_ref_id(ref):
    """'Mat.5.43' (or 'Mat.5.43-45') -> (verse id, end verse id) or None."""
    m = re.match(r"^([1-3A-Z][a-zA-Z]{2})\.(\d+)\.(\d+)(?:-(?:(\d+)\.)?(\d+))?", ref)
    if not m or m.group(1) not in BY_STEP:
        return None
    book = BY_STEP[m.group(1)]
    start = verse_id(book, int(m.group(2)), int(m.group(3)))
    end = verse_id(book, int(m.group(4) or m.group(2)), int(m.group(5))) if m.group(5) else start
    return start, max(start, end)


def plain_meaning(html, known):
    """(text, refs) of a lexicon definition: original scripts transliterated, references resolved."""
    raw_refs = []
    text = clean_html(html, raw_refs)
    # Transliterating changes lengths, so do it piecewise around the references.
    out = ""
    refs = []
    pos = 0
    for start, end, ref in raw_refs:
        out += latinize(text[pos:start])
        ids = step_ref_id(ref)
        piece = text[start:end]
        if ids and ids[0] in known:
            last = ids[1] if ids[1] in known else ids[0]
            piece = format_ref(ids[0], last)
            refs.append([len(out), len(out) + len(piece), ids[0], last])
        out += piece
        pos = end
    out += latinize(text[pos:])
    return tidy(out, refs)


def tidy(text, refs):
    """Collapse runs of spaces and blank lines, shifting reference offsets to match."""
    out = []
    mapping = []
    for ch in text:
        mapping.append(len(out))
        if ch in " \t\xa0":
            if out and out[-1] not in " \n":
                out.append(" ")
        elif ch == "\n":
            while out and out[-1] == " ":
                out.pop()
            if out and not (len(out) >= 2 and out[-1] == "\n" and out[-2] == "\n"):
                out.append("\n")
        else:
            out.append(ch)
    mapping.append(len(out))
    while out and out[-1] in " \n":
        out.pop()
    n = len(out)
    return "".join(out), [[mapping[a], min(mapping[b], n), i, j] for a, b, i, j in refs if mapping[a] < n]


# --- Texts ---

def _translit_heb(raw):
    return re.sub(r"-+", "-", raw.replace(".", "").replace("//", " ").replace("/", "-").replace("\\", "")).strip("-").lower()


def _gloss(raw):
    parts = [p.strip() for p in raw.split("/")]
    text = " ".join(p for p in parts if p)
    return re.sub(r"<([^>]*)>", lambda m: f"({m.group(1).strip('.')})", text)


def read_tahot(paths, tbesh):
    """Hebrew OT words: [(verse id, position, translit, gloss, root gloss, dStrong, lexeme, morph)], and
    {Hebrew verse id: English verse id} where the numbering differs."""
    words = []
    heb_to_eng = {}
    position = {}
    continuing = None
    for path in paths:
        for line in _lines(path):
            if not DATA_ROW.match(line):
                continue
            cols = line.split("\t")
            m = TAHOT_REF.match(cols[0])
            if not m or not cols[1].strip():
                continue
            book = BY_STEP.get(m.group(1))
            if book is None:
                continue
            ch, vs = int(m.group(2)), int(m.group(3))
            if m.group(4):
                heb_to_eng[verse_id(book, int(m.group(4)), int(m.group(5)))] = verse_id(book, ch, max(vs, 1))
            # Psalm titles are English verse 0: the NET prints them with verse 1.
            vid = verse_id(book, ch, max(vs, 1))
            slots = cols[4].split("/")
            root_index = next((i for i, s in enumerate(slots) if "{" in s), None)
            root_tag = ""
            if root_index is not None:
                tag = re.search(r"\{(H\d{4}[A-Z]?)\}", slots[root_index])
                root_tag = tag.group(1) if tag else ""
            else:
                tag = re.search(r"H\d{4}[A-Z]?", cols[4])
                root_tag = tag.group(0) if tag and not tag.group(0).startswith("H9") else ""
            gloss_slots = cols[3].split("/")
            root_gloss = gloss_slots[root_index].strip() if root_index is not None and root_index < len(gloss_slots) else ""
            lexeme = lexeme_of(root_tag, tbesh, "H") if root_tag else ""
            # A name spread over two words ("Tubal-" "cain") counts once.
            if continuing and continuing == root_tag:
                lexeme = ""
            continuing = root_tag if cols[4].rstrip().endswith("+") else None
            pos = position.get(vid, 0) + 1
            position[vid] = pos
            words.append((vid, pos, _translit_heb(cols[2]), _gloss(cols[3]), root_gloss, root_tag, lexeme, cols[5].strip()))
    return words, heb_to_eng


_ALT = re.compile(r"^(\S+) \((\w)=(.*?)\) (.*) - (\S+) in: (.*)$")


def _greek_translit(greek, translit):
    translit = unicodedata.normalize("NFC", translit)
    if re.search("[ῃῂῄῇ]", unicodedata.normalize("NFC", greek)):
        translit = re.sub(r"ēa\b", "ē", translit)
    return translit


def read_tagnt(paths, tbesg, edition="NA28"):
    """Greek NT words (NA28 text): [(verse id, position, translit, gloss, root gloss, dStrong, lexeme, morph)]."""
    words = []
    position = {}
    for path in paths:
        for line in _lines(path):
            if not DATA_ROW.match(line):
                continue
            cols = line.split("\t")
            if len(cols) < 7:
                continue
            ref = re.sub(r"[\[({#].*", "", cols[0])
            book_code, ch, vs = ref.split(".")
            book = BY_STEP.get(book_code)
            if book is None:
                continue
            editions = {re.sub(r"[»«]\d+", "", e) for e in cols[5].split("+")}
            m = re.match(r"^(.*) \((.*)\)$", cols[1])
            if not m:
                continue
            greek, translit, gloss, tags = m.group(1), m.group(2), cols[2], cols[3]
            if edition not in editions:
                alt = None
                for option in cols[6].split(" ¦ "):
                    am = _ALT.match(option.strip())
                    if am and edition in {re.sub(r"[»«]\d+", "", e) for e in am.group(6).split("+")}:
                        alt = am
                        break
                if not alt:
                    continue
                greek, translit, gloss, tags = alt.group(1), alt.group(3), alt.group(4), alt.group(5).replace("+G", " + G")
            parts = []
            for part in tags.split(" + "):
                if "=" in part:
                    tag, morph = part.split("=", 1)
                    parts.append((tag.strip(), morph.strip()))
            if not parts:
                continue
            # Crasis (κἀγώ = καί + ἐγώ): the word that isn't "and" is the one to study.
            tag, morph = next((p for p in parts if not p[0].startswith("G2532")), parts[0]) if len(parts) > 1 else parts[0]
            vid = verse_id(book, int(ch), int(vs))
            pos = position.get(vid, 0) + 1
            position[vid] = pos
            clean_gloss = re.sub(r"[¶\[\]¬{}]", "", gloss).strip(" ,.;:?!·—–")
            words.append((vid, pos, _greek_translit(greek, translit), clean_gloss, clean_gloss,
                          tag, lexeme_of(tag, tbesg, "G"), morph))
    return words

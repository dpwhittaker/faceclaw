"""The Septuagint for each Old Testament verse: Rahlfs' Greek word by word, and
Brenton's English.

Sources, in $FACECLAW_BIBLE_CACHE/sources/lxx/ (none can be fetched by the
build, so they are kept in the cache):

- rahlfs/: one file per field from eliranwong/LXX-Rahlfs-1935 (commit
  a1b5ff1c), every word keyed by the same id 1..623,693: SBL transliteration,
  lemma (OSSP), Strong's number, morphology (CCAT codes with J. Tauber's
  patches), English gloss. CC BY-NC-SA 4.0, from CCAT's morphologically
  analysed LXX (non-commercial use under CCAT's user declaration): personal
  use only, never redistributed.
- eng2lxx_merged.tsv: English (KJV/NET) verse -> Rahlfs verse(s) with their
  word id ranges, and the LXX additions to show after a verse. Built from
  OpenScriptorium/lxx-morph's verse pairs (CC BY 4.0) checked against an
  alignment of Tov's CATSS parallel Hebrew-Greek text; tools/ rebuilds it.
- eng-Brenton_vpl.zip: Brenton's 1851 translation (public domain, eBible.org),
  numbered like Rahlfs apart from Proverbs 24-36.
"""
import collections
import re
import unicodedata
import zipfile

import sources
from books import BY_STEP, verse_id
from step_data import lexeme_of, read_lexicon, read_morph

LXX = sources.CACHE / "lxx"
CORPUS_LXX = 2

# CCAT book labels in the mapping -> how the app names them (LXX book names where they differ).
DISPLAY = {
    "JoshB": "Josh", "JudgB": "Judg", "1Sam/K": "1 Kgdms", "2Sam/K": "2 Kgdms", "1/3Kgs": "3 Kgdms",
    "2/4Kgs": "4 Kgdms", "1Chr": "1 Chr", "2Chr": "2 Chr", "2Esdr": "2 Esd", "Qoh": "Eccl", "Cant": "Song",
    "DanTh": "Dan (Theodotion)", "Dan": "Dan (Old Greek)",
}
# CCAT book labels -> Brenton's VPL book codes.
BRENTON = {
    "Gen": "GEN", "Exod": "EXO", "Lev": "LEV", "Num": "NUM", "Deut": "DEU", "JoshB": "JOS", "JudgB": "JDG",
    "Ruth": "RUT", "1Sam/K": "1SA", "2Sam/K": "2SA", "1/3Kgs": "1KI", "2/4Kgs": "2KI", "1Chr": "1CH",
    "2Chr": "2CH", "2Esdr": "EZR", "Esth": "ESG", "Ps": "PSA", "Prov": "PRO", "Qoh": "ECC", "Cant": "SOL",
    "Job": "JOB", "Isa": "ISA", "Jer": "JER", "Lam": "LAM", "Ezek": "EZE", "DanTh": "DNG", "Hos": "HOS",
    "Joel": "JOE", "Amos": "AMO", "Obad": "OBA", "Jonah": "JON", "Mic": "MIC", "Nah": "NAH", "Hab": "HAB",
    "Zeph": "ZEP", "Hag": "HAG", "Zech": "ZEC", "Mal": "MAL",
}
_PROV_LETTERS = "fghiklmnopqrst"

# CCAT parts of speech -> words, and the Robinson-style prefix TEGMC uses for the same thing.
POS = {
    "N": ("Noun", "N"), "V": ("Verb", "V"), "A": ("Adjective", "A"), "P": ("Preposition", "PREP"),
    "D": ("Adverb", "ADV"), "RA": ("Article", "T"), "RD": ("Demonstrative pronoun", "D"),
    "RI": ("Interrogative/indefinite pronoun", "I"), "RP": ("Personal pronoun", "P"), "RR": ("Relative pronoun", "R"),
    "RX": ("Indefinite relative pronoun", "R"), "C": ("Conjunction", "CONJ"), "X": ("Particle", "PRT"),
    "I": ("Interjection", "INJ"), "M": ("Number", "N"),
}
CASES = {"N": "Nominative", "G": "Genitive", "D": "Dative", "A": "Accusative", "V": "Vocative"}
NUMBERS = {"S": "Singular", "D": "Dual", "P": "Plural"}
GENDERS = {"M": "Masculine", "F": "Feminine", "N": "Neuter"}
TENSES = {"P": ("Present", "P"), "I": ("Imperfect", "I"), "F": ("Future", "F"), "A": ("Aorist", "A"),
          "X": ("Perfect", "R"), "Y": ("Pluperfect", "L")}
VOICES = {"A": "Active", "M": "Middle", "P": "Passive"}
MOODS = {"I": ("Indicative", "I"), "D": ("Imperative", "M"), "S": ("Subjunctive", "S"), "O": ("Optative", "O"),
         "N": ("Infinitive", "N"), "P": ("Participle", "P")}
PERSONS = {"1": "1st", "2": "2nd", "3": "3rd"}
SHORT = {"Singular": "sing.", "Plural": "pl.", "Dual": "dual", "Masculine": "masc.", "Feminine": "fem.", "Neuter": "neut."}


def _describe_one(code, tegmc):
    """(label, short, explanation) for one CCAT code like V.AAI3S or N.DSF."""
    pos, _, parse = code.partition(".")
    pos = pos.strip()
    name, robinson = POS.get(pos, (pos, pos))
    words = []
    robinson_code = robinson
    if pos == "V" and len(parse) >= 3:
        tense, voice, mood = TENSES.get(parse[0]), VOICES.get(parse[1]), MOODS.get(parse[2])
        if tense and voice and mood:
            words += [tense[0], voice, mood[0]]
            robinson_code = f"V-{tense[1]}{parse[1]}{mood[1]}"
            rest = parse[3:]
            if mood[0] == "Participle" and len(rest) >= 2:
                words += [CASES.get(rest[0], rest[0]), NUMBERS.get(rest[1], rest[1])] + ([GENDERS.get(rest[2], rest[2])] if len(rest) > 2 else [])
                robinson_code += f"-{rest[:3]}"
            elif len(rest) >= 2:
                words += [PERSONS.get(rest[0], rest[0]), NUMBERS.get(rest[1], rest[1])]
                robinson_code += f"-{rest[:2]}"
    elif parse:
        letters = parse.replace(" ", "")
        if letters and letters[0] in CASES:
            words.append(CASES[letters[0]])
            if len(letters) > 1 and letters[1] in NUMBERS:
                words.append(NUMBERS[letters[1]])
            if len(letters) > 2 and letters[2] in GENDERS:
                words.append(GENDERS[letters[2]])
            if letters.endswith("C") and len(letters) > 3:
                words.append("Comparative")
            elif letters.endswith("S") and len(letters) > 3:
                words.append("Superlative")
            robinson_code = f"{robinson}-{letters[:3]}"
    label = " ".join([name] + words)
    short = " ".join([name] + [SHORT.get(w, w) for w in words])
    explanation = ""
    match = tegmc.get(robinson_code) or tegmc.get(robinson)
    if match:
        explanation = match[2]
    return label, short, explanation


def describe(code, tegmc):
    """The morph row for a CCAT code; crasis (C+RP.NS) is described part by part."""
    parts = [_describe_one(part, tegmc) for part in code.split("+")]
    return (" + ".join(p[0] for p in parts), " + ".join(p[1] for p in parts),
            "; ".join(p[2] for p in parts if p[2]))


def _read_field(name):
    values = {}
    with open(LXX / "rahlfs" / name, encoding="utf-8-sig") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2 and parts[0].isdigit():
                values[int(parts[0])] = parts[-1]
    return values


def _ranges(spec):
    out = []
    for piece in spec.split(";"):
        piece = piece.strip()
        if "-" in piece:
            a, b = piece.split("-")
            out.append((int(a), int(b)))
        elif piece.isdigit():
            out.append((int(piece), int(piece)))
    return out


def _brenton_key(ref):
    """'Ps 22:1' (a CCAT label) -> Brenton's 'PSA 22:1', with the Proverbs 24-36 reordering undone."""
    m = re.match(r"^(\S+) (\d+):(\d+)([a-z]*)$", ref) or re.match(r"^(\S+) (\d+)()([a-z]*)$", ref)
    if not m:
        return None
    book, chapter, verse, letter = m.group(1), int(m.group(2)), m.group(3), m.group(4)
    code = BRENTON.get(book)
    if not code:
        return None
    if not verse:  # Obadiah's single chapter: "Obad 3"
        return f"{code} 1:{chapter}{letter}"
    verse = int(verse)
    # Brenton numbers Esther's Addition A from 1:1 where Rahlfs has 1:1a.
    if book == "Esth" and chapter == 1 and verse == 1 and letter == "a":
        return "ESG 1:1"
    if book == "Prov":
        if chapter == 30 and verse <= 14:
            return f"PRO 24:22{_PROV_LETTERS[verse - 1]}"
        if chapter == 30:
            return f"PRO 24:{verse + 20}"
        if chapter == 31 and verse <= 9:
            return f"PRO 24:{verse + 53}"
        if 32 <= chapter <= 36:
            return f"PRO {chapter - 7}:{verse}{letter}"
    return f"{code} {chapter}:{verse}{letter}"


def _read_brenton():
    verses = {}
    with zipfile.ZipFile(LXX / "eng-Brenton_vpl.zip") as z:
        name = next(n for n in z.namelist() if n.endswith("_vpl.txt"))
        for line in z.read(name).decode("utf-8-sig").splitlines():
            m = re.match(r"^([1-4A-Z]{3}) (\d+:\d+[a-z]*) (.*)$", line)
            if m:
                verses[f"{m.group(1)} {m.group(2)}"] = m.group(3).strip()
    return verses


def _display_ref(ref):
    book, _, rest = ref.partition(" ")
    return f"{DISPLAY.get(book, book)} {rest}"


def _strip_accents(text):
    return "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c)).lower()


def build(db, verses, log):
    if not (LXX / "eng2lxx_merged.tsv").exists():
        log(f"Septuagint: no data in {LXX}, skipped")
        return
    log("Septuagint (Rahlfs, Brenton)")
    translit = _read_field("final_transliteration_SBL.csv")
    lemma = _read_field("OSSP_lexemes.csv")
    strongs = _read_field("final_Strongs.csv")
    morph = _read_field("patched_623693.csv")
    gloss = _read_field("beta.csv")
    brenton = _read_brenton()
    tbesg = read_lexicon(sources.step("TBESG"), "G")
    tegmc = read_morph(sources.step("TEGMC"))
    # Words without a Strong's number find their TBESG entry by lemma (accents aside).
    by_lemma = {}
    for dstrong, cols in sorted(tbesg.items()):
        by_lemma.setdefault(_strip_accents(cols[3]), dstrong)

    def word_row(vid, position, wid):
        number = strongs.get(wid, "")
        dstrong = ""
        if re.match(r"^G\d+$", number):
            dstrong = f"G{int(number[1:]):04d}"
        else:
            dstrong = by_lemma.get(_strip_accents(lemma.get(wid, "")), "")
        lexeme = lexeme_of(dstrong, tbesg, "G") if dstrong else ""
        english = gloss.get(wid, "").replace(";<br>", "; ").replace("<br>", "; ")
        row = tbesg.get(dstrong)
        # Names come glossed by transliteration ("Dabid; Thavith"); TBESG has them in English.
        if row and (lemma.get(wid, "")[:1].isupper() or not english):
            english = row[6].strip() or english
        code = morph.get(wid, "")
        return (vid, CORPUS_LXX, position, translit.get(wid, ""), english, dstrong, lexeme, f"lxx:{code}" if code else "")

    known = set(verses)
    entries = collections.defaultdict(list)  # vid -> [(first word id, ref, (a, b) ranges, brenton)]
    missing = []
    with open(LXX / "eng2lxx_merged.tsv", encoding="utf-8") as f:
        next(f)
        for line in f:
            cols = line.rstrip("\n").split("\t")
            eng_ref, stream, lxx_refs, word_ranges, plus_refs, plus_ranges = (cols + [""] * 7)[:6]
            if stream not in ("main", "alt:DanOG"):
                continue
            m = re.match(r"^(\w{3}) (\d+):(\d+|title)$", eng_ref)
            if not m:
                continue
            book = BY_STEP.get(m.group(1).capitalize() if m.group(1)[0].isalpha() else m.group(1)[0] + m.group(1)[1:].capitalize())
            if book is None:
                continue
            # The NET prints a psalm's title with verse 1.
            vid = verse_id(book, int(m.group(2)), 1 if m.group(3) == "title" else int(m.group(3)))
            if vid not in known:
                continue
            if lxx_refs.strip() in ("", "-"):
                if stream == "main":
                    missing.append(vid)
                continue
            refs = [r.strip() for r in lxx_refs.split(";")]
            ranges = _ranges(word_ranges)
            for ref, span in zip(refs, ranges):
                english = brenton.get(_brenton_key(ref) or "") if stream == "main" else None
                order = span[0] + (10_000_000 if stream != "main" else 0)
                entries[vid].append((order, ref, span, english))
            for ref, span in zip([r.strip() for r in plus_refs.split(";") if r.strip()], _ranges(plus_ranges)):
                english = brenton.get(_brenton_key(ref) or "") if stream == "main" else None
                entries[vid].append((span[0] + (10_000_000 if stream != "main" else 0), ref, span, english))

    lxx_rows = []
    word_rows = []
    for vid, items in entries.items():
        items.sort()
        for seq, (_order, ref, (a, b), english) in enumerate(items, 1):
            lxx_rows.append((vid, seq, _display_ref(ref), english))
            for n, wid in enumerate(range(a, b + 1), 1):
                word_rows.append(word_row(vid, seq * 1000 + n, wid))
    for vid in missing:
        if vid not in entries:
            lxx_rows.append((vid, 1, "", "The Septuagint has no counterpart to this verse."))
    db.executemany("INSERT INTO lxx VALUES (?,?,?,?)", lxx_rows)
    db.executemany("INSERT INTO words VALUES (?,?,?,?,?,?,?,?)", word_rows)

    codes = {row[7][4:] for row in word_rows if row[7]}
    morph_rows = []
    for code in sorted(codes):
        label, short, explanation = describe(code, tegmc)
        morph_rows.append((f"lxx:{code}", short, label, explanation))
    db.executemany("INSERT OR IGNORE INTO morph VALUES (?,?,?,?)", morph_rows)
    tagged = sum(1 for row in word_rows if row[6])
    english = sum(1 for row in lxx_rows if row[3])
    log(f"  {len(word_rows)} Greek words for {len(entries)} verses ({tagged} with a lexicon entry), "
        f"{len(lxx_rows)} LXX verses ({english} with Brenton's English), {len(missing)} verses with no counterpart, "
        f"{len(codes)} morphology codes")

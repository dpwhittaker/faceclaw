"""Full lexicon entries and Strong's definitions, keyed by plain Strong's number
("H7225", "G26"):

- the unabridged Brown-Driver-Briggs (eliranwong/unabridged-BDB-Hebrew-lexicon,
  public domain) for Hebrew and Aramaic,
- Thayer's Greek-English Lexicon (imbennyhim/Every-Promise-Thayers, CC0) for Greek,
- Strong's own definitions and KJV renderings (openscriptures HebrewLexicon,
  CC BY; openscriptures strongs Greek XML, CC0).
"""
import csv
import html as htmllib
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

from books import format_ref, verse_id
from refs import find_refs
from step_data import tidy
from translit import hebrew, latinize


def plain_strong(tag):
    """'H0776G' -> 'H776'; 'G0026' -> 'G26'."""
    m = re.match(r"^([HG])0*(\d+)", tag)
    return f"{m.group(1)}{m.group(2)}" if m else tag


def _bdb_text(html, heb_to_eng, known):
    """One BDB entry as plain text: Hebrew transliterated, bibliography dropped, references resolved."""
    html = re.sub(r"<h1>.*?</h1>", "", html, flags=re.S)
    html = re.sub(r'<div class="navigation">.*?</div>', "", html, flags=re.S)
    html = re.sub(r"<lookup[^>]*>.*?</lookup>", "", html, flags=re.S)
    html = re.sub(r"<placeholder\d*/>|<checkingNeeded/>|<wrongReferenceRemoved/>", "", html)
    html = html.replace("\\&emsp;", "  ").replace("&emsp;", "  ")
    html = re.sub(r"<br\s*/?>|<div[^>]*>|</div>|</p>|<p>", "\n", html)
    # BDB's superscript counts: bārāʾ<sup>53</sup> -> bārāʾ (53×).
    html = re.sub(r"<sup>(\d+)</sup>", r" (\1×)", html)
    out = ""
    refs = []
    pos = 0
    pattern = re.compile(r"<ref [^>]*?b=\"(\d+)\" cBegin=\"(\d+)\" vBegin=\"(\d+)\" cEnd=\"(\d+)\" vEnd=\"(\d+)\"[^>]*>(.*?)</ref>"
                         r"|<(bdbheb|bdbarc)>(.*?)</\7>|<[^>]+>", re.S)
    for m in pattern.finditer(html):
        out += htmllib.unescape(html[pos:m.start()])
        if m.group(1):
            book = int(m.group(1))
            # BDB cites the Hebrew Bible's verse numbers.
            start = verse_id(book, int(m.group(2)), int(m.group(3)))
            end = verse_id(book, int(m.group(4)), int(m.group(5)))
            start, end = heb_to_eng.get(start, start), heb_to_eng.get(end, end)
            if start in known:
                end = end if end in known and end >= start else start
                piece = format_ref(start, end)
                refs.append([len(out), len(out) + len(piece), start, end])
                out += piece
            else:
                out += htmllib.unescape(re.sub(r"<[^>]+>", "", m.group(6)))
        elif m.group(7):
            out += hebrew(htmllib.unescape(re.sub(r"<[^>]+>", "", m.group(8))))
        pos = m.end()
    out += htmllib.unescape(html[pos:])
    # Greek and Syriac quoted in the entry, and any Hebrew outside the tags.
    pieces = []
    last = 0
    shifted = []
    for a, b, i, j in refs:
        pieces.append(latinize(out[last:a]))
        start = sum(len(p) for p in pieces)
        pieces.append(out[a:b])
        shifted.append([start, start + (b - a), i, j])
        last = b
    pieces.append(latinize(out[last:]))
    return tidy("".join(pieces), shifted)


def read_bdb(zip_path, heb_to_eng, known):
    """{"H7225": (text, refs)}: every BDB entry for each Strong's number, numbered when there are several."""
    entries = {}
    with zipfile.ZipFile(zip_path) as z:
        name = next(n for n in z.namelist() if n.endswith(".csv") and "__MACOSX" not in n)
        rows = z.read(name).decode("utf-8").splitlines()
    csv.field_size_limit(sys.maxsize)
    for row in csv.reader(rows, delimiter="\t", quoting=csv.QUOTE_NONE):
        if len(row) < 3 or not row[0].startswith("BDB"):
            continue
        text, refs = _bdb_text(row[2], heb_to_eng, known)
        if not text:
            continue
        for strong in row[1].split("_"):
            strong = plain_strong(strong.strip())
            if strong:
                entries.setdefault(strong, []).append((text, refs))
    merged = {}
    for strong, items in entries.items():
        if len(items) == 1:
            merged[strong] = items[0]
            continue
        text = ""
        refs = []
        for index, (body, body_refs) in enumerate(items):
            if text:
                text += "\n\n"
            # Homographs are numbered I., II. in BDB itself; number the rest.
            head = "" if re.match(r"^[IV]+\.", body) else f"{'I' * (index + 1) if index < 3 else index + 1}. "
            base = len(text) + len(head)
            text += head + body
            refs += [[a + base, b + base, i, j] for a, b, i, j in body_refs]
        merged[strong] = (text, refs)
    return merged


def read_thayer(zip_path, known):
    """{"G26": (text, refs)} from the Every-Promise Thayer's Markdown chapters."""
    entries = {}
    with zipfile.ZipFile(zip_path) as z:
        for name in sorted(n for n in z.namelist() if re.search(r"/book/.*\.md$", n)):
            text = z.read(name).decode("utf-8")
            for block in re.split(r"\n---+\n", text):
                m = re.search(r"`Strong's (G\d+)`", block)
                if not m:
                    continue
                body = block[m.end():].strip()
                body = re.sub(r"[*_`#>]", "", body)
                body = latinize(body)
                body = re.sub(r"[ \t]+", " ", body)
                body = re.sub(r"\n{3,}", "\n\n", body).strip()
                refs = [[a, b, i, j] for a, b, i, j in find_refs(body, known)]
                entries[plain_strong(m.group(1))] = (body, refs)
    return entries


def read_hebrew_strongs(path):
    """{"H7225": "the first, in place ... KJV: beginning, chief(-est), ..."}."""
    ns = {"o": "http://openscriptures.github.com/morphhb/namespace"}
    root = ET.parse(path).getroot()
    out = {}
    for entry in root.iter("{http://openscriptures.github.com/morphhb/namespace}entry"):
        sid = entry.get("id")
        if not sid:
            continue
        meaning = entry.find("o:meaning", ns)
        usage = entry.find("o:usage", ns)
        text = re.sub(r"\s+", " ", "".join(meaning.itertext())).strip() if meaning is not None else ""
        kjv = re.sub(r"\s+", " ", "".join(usage.itertext())).strip() if usage is not None else ""
        out[plain_strong(sid)] = _strongs_line(text, kjv)
    return out


def read_greek_strongs(path):
    """{"G26": "love, i.e. affection or benevolence ... KJV: (feast of) charity(-ably), dear, love."}."""
    root = ET.parse(path).getroot()
    out = {}
    for entry in root.iter("entry"):
        number = entry.get("strongs")
        if not number:
            continue
        definition = entry.find("strongs_def")
        kjv = entry.find("kjv_def")
        text = re.sub(r"\s+", " ", "".join(definition.itertext())).strip() if definition is not None else ""
        renderings = re.sub(r"\s+", " ", "".join(kjv.itertext())).strip().lstrip(":-").strip() if kjv is not None else ""
        out[f"G{int(number)}"] = _strongs_line(latinize(text), renderings)
    return out


def _strongs_line(definition, kjv):
    definition = definition.strip().rstrip(";")
    if kjv:
        return f"{definition}\nKJV: {kjv}" if definition else f"KJV: {kjv}"
    return definition

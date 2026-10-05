"""Read the NET Bible 2.1 "Full Notes" ePub (bible.org) into verses and notes.

Each chapter is an XHTML file (fileN.xhtml) whose note markers link into a
companion fileN_notes.xhtml. Verse numbers are inline spans, a verse can run
across several poetry lines, and section headings, psalm superscriptions and
the like are paragraphs of their own (which can carry notes too). Parsed as
XML: the notes nest <p> in <p>, which an HTML parser would break apart.
"""
import re
import zipfile
import xml.etree.ElementTree as ET

from books import BY_NET_NAME, verse_id
from translit import latinize

X = "{http://www.w3.org/1999/xhtml}"
HEADING_CLASSES = {"paragraphtitle"}
INTRO_CLASSES = {"psasuper", "sosspeaker", "lamhebrew"}
PROSE_CLASSES = {"bodytext", "bodyblock", "quote"}
POETRY_CLASSES = {"poetry", "otpoetry", "poetrybreak"}
# Where a note on a heading or superscription is anchored (instead of a text offset).
ON_HEADING = -1
ON_INTRO = -2


class _Sink:
    """Accumulates raw text with the raw offsets of note markers and poetry line starts."""

    def __init__(self):
        self.text = ""
        self.notes = []  # (raw offset, note id)
        self.lines = []

    def add(self, text):
        if text:
            self.text += text


def _norm(text):
    return re.sub(r"\s+", " ", text).lstrip()


def _finish(sink):
    """Collapse whitespace, turn poetry line starts into newlines, and map the note offsets."""
    text = _norm(sink.text).rstrip()
    chars = list(text)
    for raw in sink.lines:
        at = len(_norm(sink.text[:raw]).rstrip())
        if 0 < at < len(chars) and chars[at] == " ":
            chars[at] = "\n"
    notes = [(min(len(_norm(sink.text[:raw]).rstrip()), len(text)), nid) for raw, nid in sink.notes]
    return "".join(chars), notes


def read_epub(path):
    """{verse id: {"text", "heading", "intro", "para", "notes": [(anchor, note id)]}}, {note id: [(kind, html)]}."""
    z = zipfile.ZipFile(path)
    load = lambda name: ET.fromstring(z.read(name).decode("utf-8").replace("&nbsp;", "\xa0"))
    spine = re.findall(r'<itemref idref="(file\d+)"', z.read("OEBPS/content.opf").decode())
    verses = {}
    order = []
    chapter_files = []

    for fid in spine:
        root = load(f"OEBPS/{fid}.xhtml")
        title = root.find(f"{X}head/{X}title").text or ""
        m = re.match(r"NET Bible 2\.1 (.+) (\d+)$", title)
        if not m:
            continue  # a book's contents page (its _notes file is a stale copy)
        book = BY_NET_NAME[m.group(1)]
        chapter_files.append(fid)
        state = {"current": None, "pending": [], "new_para": False}
        # Text before a chapter's first verse continues the previous verse (1 Sam 20:42b, Neh 7:73b).
        if order and order[-1] // 1_000_000 == book:
            state["current"] = verses[order[-1]]

        def walk(element, sink):
            for child in element:
                tag = child.tag.replace(X, "")
                cls = child.get("class", "")
                if tag == "span" and cls == "verse":
                    c, v = map(int, child.text.split(":"))
                    vid = verse_id(book, c, v)
                    record = verses.get(vid)
                    if record is None:
                        record = {"sink": _Sink(), "heads": [], "para": False}
                        verses[vid] = record
                        order.append(vid)
                    record["heads"] += state["pending"]
                    state["pending"] = []
                    if state["new_para"] and not record["sink"].text.strip():
                        record["para"] = True
                    state["new_para"] = False
                    state["current"] = record
                    sink = record["sink"]
                    sink.add(child.tail.lstrip() if child.tail else "")
                    continue
                anchor = child.find(X + "a") if tag == "sup" else None
                if anchor is not None and anchor.get("id", "").startswith("n"):
                    sink.notes.append((len(sink.text), anchor.get("id")))
                    sink.add(child.tail)
                    continue
                if tag == "p" and (cls in HEADING_CLASSES or cls in INTRO_CLASSES):
                    head = _Sink()
                    head.add(child.text)
                    walk(child, head)
                    text, notes = _finish(head)
                    state["pending"].append(("heading" if cls in HEADING_CLASSES else "intro", text, [nid for _, nid in notes]))
                    continue
                if tag == "p":
                    state["new_para"] = cls in PROSE_CLASSES
                    current = state["current"]
                    if current is not None:
                        s = current["sink"]
                        if s.text and not s.text.endswith(" "):
                            s.add(" ")
                        if cls in POETRY_CLASSES:
                            s.lines.append(len(s.text))
                        s.add(child.text)
                        walk(child, s)
                        s.add(child.tail)
                    else:
                        walk(child, sink)
                    continue
                if tag in ("h1", "h2"):
                    continue
                if tag == "span" and cls == "smcaps":
                    sink.add((child.text or "").upper())
                    walk(child, sink)
                    sink.add(child.tail)
                    continue
                sink.add(child.text)
                walk(child, sink)
                sink.add(child.tail)

        walk(root.find(X + "body"), _Sink())

    out = {}
    for vid in order:
        record = verses[vid]
        text, notes = _finish(record["sink"])
        headings = [t for kind, t, _ in record["heads"] if kind == "heading"]
        intros = [t for kind, t, _ in record["heads"] if kind == "intro"]
        anchored = []
        for kind, _, nids in record["heads"]:
            anchored += [(ON_HEADING if kind == "heading" else ON_INTRO, nid) for nid in nids]
        out[vid] = {
            "text": text,
            "heading": " / ".join(headings) or None,
            "intro": " ".join(intros) or None,
            "para": record["para"],
            "notes": anchored + notes,
        }

    notes = {}
    for fid in chapter_files:
        for p in load(f"OEBPS/{fid}_notes.xhtml").find(X + "body"):
            nid = p.get("id")
            if not nid:
                continue
            parts = []
            for sub in p.findall(X + "p"):
                kind, body = _note_text(sub)
                parts.append((kind, body))
            notes[nid] = parts
    return out, notes


def _note_text(element):
    """(tn|sn|tc|"", plain text) of one typed note paragraph: original-script quotes dropped (their transliteration follows them)."""
    pieces = []

    def walk(el):
        cls = el.get("class", "")
        tag = el.tag.replace(X, "")
        if tag == "span" and cls in ("hebrew", "greek"):
            # Kept only when no transliteration accompanies it (rare): latinized.
            pieces.append(("orig", "".join(el.itertext())))
        elif tag == "span" and cls == "smcaps":
            pieces.append(("text", "".join(el.itertext()).upper()))
        else:
            pieces.append(("text", el.text or ""))
            for child in el:
                walk(child)
                pieces.append(("text", child.tail or ""))

    pieces.append(("text", element.text or ""))
    for child in element:
        walk(child)
        pieces.append(("text", child.tail or ""))
    text = ""
    for i, (kind, piece) in enumerate(pieces):
        if kind == "orig":
            following = "".join(p for _, p in pieces[i + 1:i + 4])
            # "(<hebrew>, translit)" or "<greek> (translit)": the transliteration is there already.
            if re.match(r"\s*(,|\()", following):
                continue
            text += latinize(piece)
        else:
            text += piece
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\(\s*,\s*", "(", text)
    text = re.sub(r"\(\s*\)", "", text)
    text = re.sub(r"\s+([,.;:)])", r"\1", text)
    m = re.match(r"(tn|sn|tc|map)\s+", text)
    if m:
        return m.group(1), text[m.end():]
    return "", text

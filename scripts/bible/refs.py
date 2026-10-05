"""Find Scripture references in prose (NET notes, lexicon entries) and resolve
them to verse ids, so the app can follow them.

Handles "Gen 1:1", "1 Sam 2:1-3", "Luke 7:12; 9:38", "John 1:1, 14", "Jude 5",
and, given the verse the prose belongs to, "v. 5", "vv. 5-7", and a bare
"cf. 1:14". A reference is kept only if the verse exists (the caller passes
the set of verse ids).
"""
import re

from books import SINGLE_CHAPTER, SPELLINGS, verse_id

_names = sorted(SPELLINGS, key=len, reverse=True)
_book_alt = "|".join(re.escape(name).replace(r"\ ", r"\s") for name in _names)
_DASH = "[-–—]"
_BOOK_REF = re.compile(
    rf"(?<![\w])(?P<book>{_book_alt})\.?\s+(?P<c>\d{{1,3}})(?::(?P<v>\d{{1,3}})(?:{_DASH}(?:(?P<c2>\d{{1,3}}):)?(?P<v2>\d{{1,3}}))?)?(?![\d:])"
)
_CONTINUE = re.compile(
    rf"\s*[;,]\s*(?:and\s+)?(?:(?P<c>\d{{1,3}}):)?(?P<v>\d{{1,3}})(?:{_DASH}(?:(?P<c2>\d{{1,3}}):)?(?P<v2>\d{{1,3}}))?(?![\d:])(?!\s*(?:{_book_alt})\b)"
)
_VERSES = re.compile(rf"\b(?P<vv>vv?)\.\s*(?P<v>\d{{1,3}})(?:{_DASH}(?P<v2>\d{{1,3}}))?(?![\d:])")
_BARE = re.compile(rf"(?:\bcf\.|\bsee|\bSee|\balso|\(|\[)\s*(?P<c>\d{{1,3}}):(?P<v>\d{{1,3}})(?:{_DASH}(?:(?P<c2>\d{{1,3}}):)?(?P<v2>\d{{1,3}}))?(?![\d:])")


def _span(book, c, v, c2, v2, known):
    start = verse_id(book, c, v)
    if start not in known:
        return None
    end = verse_id(book, c2 if c2 else c, v2) if v2 else start
    if end not in known or end < start:
        end = start
    return start, end


def find_refs(text, known, book=None, chapter=None):
    """[(start, end, first verse id, last verse id)] for each reference in text, in order."""
    found = []
    taken = []

    def free(a, b):
        return all(b <= s or a >= e for s, e in taken)

    def add(a, b, span):
        if span and free(a, b):
            found.append((a, b, span[0], span[1]))
            taken.append((a, b))

    for m in _BOOK_REF.finditer(text):
        b = SPELLINGS.get(re.sub(r"\s+", " ", m.group("book")))
        if b is None:
            continue
        c, v = int(m.group("c")), m.group("v")
        if v is None:
            # "Jude 5": a single-chapter book cites verses alone.
            if b not in SINGLE_CHAPTER:
                continue
            c, v = 1, int(m.group("c"))
            span = _span(b, 1, v, None, None, known)
        else:
            span = _span(b, c, int(v), m.group("c2") and int(m.group("c2")), m.group("v2") and int(m.group("v2")), known)
        if not span:
            continue
        add(m.start(), m.end(), span)
        # "; 9:38", ", 14": more of the same book (and chapter).
        pos = m.end()
        while True:
            more = _CONTINUE.match(text, pos)
            if not more:
                break
            if more.group("c"):
                c = int(more.group("c"))
            elif b in SINGLE_CHAPTER:
                c = 1
            cont = _span(b, c, int(more.group("v")), more.group("c2") and int(more.group("c2")), more.group("v2") and int(more.group("v2")), known)
            if not cont:
                break
            lead = len(more.group(0)) - len(more.group(0).lstrip(" ;,and"))
            add(more.start() + lead, more.end(), cont)
            pos = more.end()

    if book is not None and chapter is not None:
        for m in _VERSES.finditer(text):
            add(m.start(), m.end(), _span(book, chapter, int(m.group("v")), None, m.group("v2") and int(m.group("v2")), known))
            pos = m.end()
            while True:
                more = re.match(r"\s*,\s*(?:and\s+)?(\d{1,3})(?:[-–](\d{1,3}))?(?![\d:])", text[pos:])
                if not more or not more.group(1):
                    break
                span = _span(book, chapter, int(more.group(1)), None, more.group(2) and int(more.group(2)), known)
                if not span:
                    break
                lead = len(more.group(0)) - len(more.group(0).lstrip(" ,and"))
                add(pos + lead, pos + more.end(), span)
                pos += more.end()
        for m in _BARE.finditer(text):
            c, v = int(m.group("c")), int(m.group("v"))
            span = _span(book, c, v, m.group("c2") and int(m.group("c2")), m.group("v2") and int(m.group("v2")), known)
            if not span or not free(m.start("c"), m.end()):
                continue
            add(m.start("c"), m.end(), span)
            pos = m.end()
            while True:
                more = _CONTINUE.match(text, pos)
                if not more:
                    break
                if more.group("c"):
                    c = int(more.group("c"))
                cont = _span(book, c, int(more.group("v")), more.group("c2") and int(more.group("c2")), more.group("v2") and int(more.group("v2")), known)
                if not cont:
                    break
                lead = len(more.group(0)) - len(more.group(0).lstrip(" ;,and"))
                add(more.start() + lead, more.end(), cont)
                pos = more.end()

    found.sort()
    return found

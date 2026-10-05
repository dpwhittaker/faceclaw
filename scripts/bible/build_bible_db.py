#!/usr/bin/env python3
"""Build the Faceclaw Bible app's database (bible.sqlite).

    scripts/bible/build_bible_db.py [--net-epub PATH] [--out PATH]

Sources are downloaded once into ~/.cache/faceclaw-bible/sources (see
sources.py); the NET ePub has to be downloaded by hand (see there). The
output holds copyrighted text (the NET Bible and its notes, licensed for
personal study), so it is built locally and pushed to the phone with
push_bible_db.sh; never commit it.

Tables (verse ids are BBCCCVVV in the NET's English versification):
  meta(key, value)
  verses(id, text, heading, intro, para, note_count, xref_count)
  notes(verse, seq, marker, kind, body, refs)      marker: text offset, -1 heading, -2 superscription
  xrefs(verse, seq, target, target_end, votes)
  words(verse, corpus, pos, translit, gloss, dstrong, lexeme, morph)   corpus 0 Hebrew, 1 Greek NT, 2 LXX
  lxx(verse, seq, ref, english)
  lexicon(dstrong, lexeme, lang, lemma, gloss, pos, meaning, meaning_refs, strong)
  lexemes(lexeme, verses, glosses, senses)
  entries(strong, source, text, refs, strongs)
  morph(code, short, label, explanation)
"""
import argparse
import collections
import datetime
import json
import os
import re
import sqlite3
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lexicons  # noqa: E402
import net_epub  # noqa: E402
import sources  # noqa: E402
import step_data  # noqa: E402
from books import BY_OSIS, verse_id  # noqa: E402
from refs import find_refs  # noqa: E402

SCHEMA = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE verses(id INTEGER PRIMARY KEY, text TEXT NOT NULL, heading TEXT, intro TEXT, para INTEGER,
  note_count INTEGER, xref_count INTEGER);
CREATE TABLE notes(verse INTEGER, seq INTEGER, marker INTEGER, kind TEXT, body TEXT, refs TEXT);
CREATE TABLE xrefs(verse INTEGER, seq INTEGER, target INTEGER, target_end INTEGER, votes INTEGER);
CREATE TABLE words(verse INTEGER, corpus INTEGER, pos INTEGER, translit TEXT, gloss TEXT, dstrong TEXT,
  lexeme TEXT, morph TEXT);
CREATE TABLE lxx(verse INTEGER, seq INTEGER, ref TEXT, english TEXT);
CREATE TABLE lexicon(dstrong TEXT PRIMARY KEY, lexeme TEXT, lang TEXT, lemma TEXT, gloss TEXT, pos TEXT,
  meaning TEXT, meaning_refs TEXT, strong TEXT);
CREATE TABLE lexemes(lexeme TEXT PRIMARY KEY, verses INTEGER, glosses TEXT, senses TEXT);
CREATE TABLE entries(strong TEXT PRIMARY KEY, source TEXT, text TEXT, refs TEXT, strongs TEXT);
CREATE TABLE morph(code TEXT PRIMARY KEY, short TEXT, label TEXT, explanation TEXT);
"""

INDEXES = """
CREATE INDEX notes_verse ON notes(verse, seq);
CREATE INDEX xrefs_verse ON xrefs(verse, seq);
CREATE INDEX words_verse ON words(verse, corpus, pos);
CREATE INDEX words_lexeme ON words(lexeme, corpus, verse);
CREATE INDEX lxx_verse ON lxx(verse, seq);
"""

CORPUS_HEBREW, CORPUS_GREEK, CORPUS_LXX = 0, 1, 2


def log(message):
    print(message, file=sys.stderr, flush=True)


def build_net(db, epub_path):
    log("NET text and notes")
    verses, notes = net_epub.read_epub(epub_path)
    known = set(verses)
    note_rows = []
    for vid, record in verses.items():
        book, chapter = vid // 1_000_000, (vid // 1_000) % 1_000
        seq = 0
        for anchor, nid in sorted(record["notes"], key=lambda item: item[0]):
            for kind, body in notes.get(nid, []):
                refs = [[a, b, i, j] for a, b, i, j in find_refs(body, known, book, chapter)]
                seq += 1
                note_rows.append((vid, seq, anchor, kind, body, json.dumps(refs) if refs else None))
        record["note_count"] = seq
    db.executemany("INSERT INTO notes VALUES (?,?,?,?,?,?)", note_rows)
    log(f"  {len(verses)} verses, {len(note_rows)} notes, {sum(1 for r in note_rows if r[5])} with references")
    return verses


def build_xrefs(db, verses):
    log("Cross-references (OpenBible.info)")
    import zipfile
    path = sources.fetch(sources.OPENBIBLE_XREFS)
    known = set(verses)

    def to_id(osis):
        book, chapter, verse = osis.split(".")
        if book not in BY_OSIS:
            return None
        vid = verse_id(BY_OSIS[book], int(chapter), int(verse))
        # The ESV splits the NET's 2 Cor 13:12 in two.
        if book == "2Cor" and chapter == "13" and int(verse) >= 13:
            vid -= 1
        return vid

    rows = collections.defaultdict(list)
    with zipfile.ZipFile(path) as z:
        name = next(n for n in z.namelist() if n.endswith(".txt"))
        for line in z.read(name).decode("utf-8").splitlines()[1:]:
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            votes = int(parts[2])
            if votes <= 0:
                continue
            source = to_id(parts[0])
            ends = parts[1].split("-")
            target = to_id(ends[0])
            target_end = to_id(ends[1]) if len(ends) > 1 else target
            if source not in known or target not in known:
                continue
            if target_end not in known or target_end < target:
                target_end = target
            rows[source].append((target, target_end, votes))
    out = []
    for source, targets in rows.items():
        targets.sort(key=lambda t: (-t[2], t[0]))
        for seq, (target, target_end, votes) in enumerate(targets, 1):
            out.append((source, seq, target, target_end, votes))
        verses[source]["xref_count"] = len(targets)
    db.executemany("INSERT INTO xrefs VALUES (?,?,?,?,?)", out)
    log(f"  {len(out)} cross-references from {len(rows)} verses")


def insert_verses(db, verses):
    db.executemany(
        "INSERT INTO verses VALUES (?,?,?,?,?,?,?)",
        [(vid, r["text"], r["heading"], r["intro"], 1 if r["para"] else 0, r.get("note_count", 0), r.get("xref_count", 0))
         for vid, r in sorted(verses.items())],
    )


def build_words(db, verses):
    log("Hebrew and Greek texts (STEPBible TAHOT, TAGNT)")
    tbesh = step_data.read_lexicon(sources.step("TBESH"), "H")
    tbesg = step_data.read_lexicon(sources.step("TBESG"), "G")
    hebrew, heb_to_eng = step_data.read_tahot([sources.step(f"TAHOT{i}") for i in range(1, 5)], tbesh)
    greek = step_data.read_tagnt([sources.step("TAGNT1"), sources.step("TAGNT2")], tbesg)
    known = set(verses)
    stray = collections.Counter()
    rows = []
    for corpus, words in ((CORPUS_HEBREW, hebrew), (CORPUS_GREEK, greek)):
        for vid, pos, translit, gloss, _root_gloss, dstrong, lexeme, morph in words:
            if vid not in known:
                stray[vid] += 1
            rows.append((vid, corpus, pos, translit, gloss, dstrong, lexeme, morph))
    db.executemany("INSERT INTO words VALUES (?,?,?,?,?,?,?,?)", rows)
    log(f"  {len(hebrew)} Hebrew and {len(greek)} Greek words; {len(stray)} verse ids not in the NET: "
        f"{sorted(stray)[:12]}")
    return tbesh, tbesg, hebrew + greek, heb_to_eng


def build_lexicon(db, verses, tbesh, tbesg, words, heb_to_eng):
    log("Lexicons")
    known = set(verses)
    bdb = lexicons.read_bdb(sources.fetch(sources.BDB, "unabridged-BDB-Hebrew-lexicon.csv.zip"), heb_to_eng, known)
    thayer = lexicons.read_thayer(sources.fetch(sources.THAYER, "every-promise-thayers.zip"), known)
    strongs = lexicons.read_hebrew_strongs(sources.fetch(sources.HEBREW_STRONG))
    strongs.update(lexicons.read_greek_strongs(sources.fetch(sources.GREEK_STRONG)))

    used = {w[5] for w in words if w[5]} | {row[0] for row in db.execute("SELECT DISTINCT dstrong FROM words WHERE dstrong != ''")}
    rows = []
    for table, prefix in ((tbesh, "H"), (tbesg, "G")):
        for dstrong, cols in table.items():
            lang = cols[5].split(":", 1)[0] if ":" in cols[5] else prefix
            lang = "A" if lang == "A" else prefix
            meaning, meaning_refs = step_data.plain_meaning(cols[7], known)
            rows.append((
                dstrong,
                step_data.lexeme_of(dstrong, table, prefix),
                lang,
                cols[4].replace(".", "").strip(),
                cols[6].strip(),
                step_data.pos_words(cols[5]),
                meaning,
                json.dumps(meaning_refs) if meaning_refs else None,
                lexicons.plain_strong(dstrong),
            ))
    # Tags the texts use bare where the lexicon only has sense splits (G2424 for G2424G "Jesus"):
    # alias them to the number's first sense.
    by_key = {r[0]: r for r in rows}
    aliased = 0
    for tag in sorted(used - set(by_key)):
        number = re.match(r"^([HG]\d{4})", tag)
        sense = next((r for key, r in sorted(by_key.items()) if number and key.startswith(number.group(1))), None)
        if sense:
            rows.append((tag,) + sense[1:])
            aliased += 1
    missing = sorted(used - {r[0] for r in rows})
    db.executemany("INSERT INTO lexicon VALUES (?,?,?,?,?,?,?,?,?)", rows)
    log(f"  {len(rows)} lexicon senses ({aliased} aliases for bare tags); {len(missing)} tags without one: {missing[:10]}")

    entries = []
    for strong in sorted(set(bdb) | set(thayer) | set(strongs)):
        full = bdb.get(strong) if strong.startswith("H") else thayer.get(strong)
        source = ("Brown-Driver-Briggs" if strong.startswith("H") else "Thayer") if full else None
        text, refs = full if full else (None, [])
        entries.append((strong, source, text, json.dumps(refs) if refs else None, strongs.get(strong)))
    db.executemany("INSERT INTO entries VALUES (?,?,?,?,?)", entries)
    log(f"  {len(entries)} Strong's entries ({len(bdb)} BDB, {len(thayer)} Thayer)")


# Words that open a rendering without being the word itself ("he created", "they have been created").
_LEADING = set("and but or the a an he she it they we you i his her its their my your our will shall would should "
               "was were is are am be been being have has had to let may might must do did does o "
               "in from of with by for on at upon into towards toward some".split())
_TRAILING = {"of", "to", "towards", "toward"}


def _normal_gloss(gloss):
    gloss = re.sub(r"\[[^\]]*\]|\([^)]*\)|<[^>]*>", "", gloss)
    gloss = re.sub(r"[^\w\s'-]", "", gloss).strip().lower()
    words = gloss.split()
    while len(words) > 1 and words[0] in _LEADING:
        words.pop(0)
    while len(words) > 1 and words[-1] in _TRAILING:
        words.pop()
    return " ".join(words)


def build_lexemes(db, words):
    """Per lexeme: verses it occurs in, how the Hebrew and Greek texts render it, and its STEP senses."""
    log("Concordance summaries")
    glosses = collections.defaultdict(collections.Counter)
    senses = collections.defaultdict(collections.Counter)
    for _vid, _pos, _translit, _gloss, root_gloss, dstrong, lexeme, _morph in words:
        if not lexeme:
            continue
        normal = _normal_gloss(root_gloss)
        if normal:
            glosses[lexeme][normal] += 1
        senses[lexeme][dstrong] += 1
    verse_counts = dict(db.execute("SELECT lexeme, COUNT(DISTINCT verse) FROM words WHERE lexeme != '' GROUP BY lexeme"))
    sense_gloss = dict(db.execute("SELECT dstrong, gloss FROM lexicon"))
    rows = []
    for lexeme, verse_count in verse_counts.items():
        top = glosses[lexeme].most_common(40)
        sense_list = [[d, sense_gloss.get(d, ""), n] for d, n in senses[lexeme].most_common()] if len(senses[lexeme]) > 1 else []
        rows.append((lexeme, verse_count, json.dumps(top, ensure_ascii=False), json.dumps(sense_list, ensure_ascii=False) if sense_list else None))
    db.executemany("INSERT INTO lexemes VALUES (?,?,?,?)", rows)
    log(f"  {len(rows)} lexemes")


def build_morph(db):
    log("Morphology codes")
    rows = []
    for key in ("TEHMC", "TEGMC"):
        for code, (short, label, explanation) in step_data.read_morph(sources.step(key)).items():
            rows.append((code, short, label, explanation))
    db.executemany("INSERT OR IGNORE INTO morph VALUES (?,?,?,?)", rows)
    log(f"  {len(rows)} codes")


def build_lxx(db, verses):
    try:
        import lxx  # noqa: F401
    except ImportError:
        log("Septuagint: lxx.py not present yet, skipped")
        return
    lxx.build(db, verses, log)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--net-epub", help="the NET 2.1 Full Notes ePub (default: the cache)")
    parser.add_argument("--out", default=str(sources.CACHE.parent / "bible.sqlite"))
    args = parser.parse_args()
    epub = sources.net_epub(args.net_epub)
    tmp = args.out + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript(SCHEMA)
    verses = build_net(db, epub)
    build_xrefs(db, verses)
    insert_verses(db, verses)
    tbesh, tbesg, words, heb_to_eng = build_words(db, verses)
    build_lxx(db, verses)
    build_lexicon(db, verses, tbesh, tbesg, words, heb_to_eng)
    build_morph(db)
    log("Indexes")
    db.executescript(INDEXES)
    build_lexemes(db, words)
    db.executemany("INSERT INTO meta VALUES (?,?)", [
        ("schema", "1"),
        ("built", datetime.datetime.now().isoformat(timespec="seconds")),
        ("sources", "NET Bible 2.1 with translators' notes, © 1996-2019 Biblical Studies Press (personal study use); "
                    "cross-references from OpenBible.info (CC BY); Hebrew, Greek, lexicons and morphology from "
                    "STEP Bible, www.STEPBible.org (CC BY); unabridged Brown-Driver-Briggs (public domain); "
                    "Thayer's Greek-English Lexicon (Every Promise, CC0); Strong's dictionaries (Open Scriptures)"),
    ])
    db.commit()
    db.execute("VACUUM")
    db.close()
    os.replace(tmp, args.out)
    log(f"Wrote {args.out} ({os.path.getsize(args.out) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()

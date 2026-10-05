"""The 66 books, with every name the Bible app's sources use for them.

Book numbers (1-66, Genesis to Revelation) match app/apps/bible/books.ts, and
verse ids are BBCCCVVV, as there.
"""
import re

# number, OSIS, NET ePub name, STEP code, other spellings (|-separated) found in notes and lexicons
_BOOKS = [
    (1, "Gen", "Genesis", "Gen", "Ge|Gn"),
    (2, "Exod", "Exodus", "Exo", "Ex|Exo"),
    (3, "Lev", "Leviticus", "Lev", "Le|Lv"),
    (4, "Num", "Numbers", "Num", "Nu|Nm"),
    (5, "Deut", "Deuteronomy", "Deu", "Dt|De"),
    (6, "Josh", "Joshua", "Jos", "Jos|Jsh"),
    (7, "Judg", "Judges", "Jdg", "Jdg|Jg|Jdgs"),
    (8, "Ruth", "Ruth", "Rut", "Ru|Rth"),
    (9, "1Sam", "1 Samuel", "1Sa", "1Sa|1Sm|1 Sa"),
    (10, "2Sam", "2 Samuel", "2Sa", "2Sa|2Sm|2 Sa"),
    (11, "1Kgs", "1 Kings", "1Ki", "1Ki|1Kg|1 Ki|1 Kin"),
    (12, "2Kgs", "2 Kings", "2Ki", "2Ki|2Kg|2 Ki|2 Kin"),
    (13, "1Chr", "1 Chronicles", "1Ch", "1Ch|1 Ch|1 Chron"),
    (14, "2Chr", "2 Chronicles", "2Ch", "2Ch|2 Ch|2 Chron"),
    (15, "Ezra", "Ezra", "Ezr", "Ezr"),
    (16, "Neh", "Nehemiah", "Neh", "Ne"),
    (17, "Esth", "Esther", "Est", "Est|Es"),
    (18, "Job", "Job", "Job", "Jb"),
    (19, "Ps", "Psalms", "Psa", "Pss|Psa|Psalm|Psm"),
    (20, "Prov", "Proverbs", "Pro", "Pro|Pr|Prv"),
    (21, "Eccl", "Ecclesiastes", "Ecc", "Ecc|Ec|Qoh"),
    (22, "Song", "Song of Songs", "Sng", "Sng|Son|SoS|Cant|Song of Solomon"),
    (23, "Isa", "Isaiah", "Isa", "Is"),
    (24, "Jer", "Jeremiah", "Jer", "Je|Jr"),
    (25, "Lam", "Lamentations", "Lam", "La"),
    (26, "Ezek", "Ezekiel", "Ezk", "Ezk|Eze"),
    (27, "Dan", "Daniel", "Dan", "Da|Dn"),
    (28, "Hos", "Hosea", "Hos", "Ho"),
    (29, "Joel", "Joel", "Jol", "Jol|Joe|Jl"),
    (30, "Amos", "Amos", "Amo", "Amo|Am"),
    (31, "Obad", "Obadiah", "Oba", "Oba|Ob"),
    (32, "Jonah", "Jonah", "Jon", "Jon|Jnh"),
    (33, "Mic", "Micah", "Mic", "Mi"),
    (34, "Nah", "Nahum", "Nam", "Nam|Na"),
    (35, "Hab", "Habakkuk", "Hab", "Hb"),
    (36, "Zeph", "Zephaniah", "Zep", "Zep|Zp"),
    (37, "Hag", "Haggai", "Hag", "Hg"),
    (38, "Zech", "Zechariah", "Zec", "Zec|Zc"),
    (39, "Mal", "Malachi", "Mal", "Ml"),
    (40, "Matt", "Matthew", "Mat", "Mat|Mt"),
    (41, "Mark", "Mark", "Mrk", "Mrk|Mar|Mk|Mr"),
    (42, "Luke", "Luke", "Luk", "Luk|Lk|Lu"),
    (43, "John", "John", "Jhn", "Jhn|Joh|Jn"),
    (44, "Acts", "Acts", "Act", "Act|Ac"),
    (45, "Rom", "Romans", "Rom", "Ro|Rm"),
    (46, "1Cor", "1 Corinthians", "1Co", "1Co|1 Co"),
    (47, "2Cor", "2 Corinthians", "2Co", "2Co|2 Co"),
    (48, "Gal", "Galatians", "Gal", "Ga"),
    (49, "Eph", "Ephesians", "Eph", "Ep"),
    (50, "Phil", "Philippians", "Php", "Php|Phi"),
    (51, "Col", "Colossians", "Col", "Co"),
    (52, "1Thess", "1 Thessalonians", "1Th", "1Th|1 Th|1 Thes"),
    (53, "2Thess", "2 Thessalonians", "2Th", "2Th|2 Th|2 Thes"),
    (54, "1Tim", "1 Timothy", "1Ti", "1Ti|1 Ti"),
    (55, "2Tim", "2 Timothy", "2Ti", "2Ti|2 Ti"),
    (56, "Titus", "Titus", "Tit", "Tit|Ti"),
    (57, "Phlm", "Philemon", "Phm", "Phm|Phlm|Philem"),
    (58, "Heb", "Hebrews", "Heb", "He"),
    (59, "Jas", "James", "Jas", "Jam|Jm"),
    (60, "1Pet", "1 Peter", "1Pe", "1Pe|1 Pe|1Pt"),
    (61, "2Pet", "2 Peter", "2Pe", "2Pe|2 Pe|2Pt"),
    (62, "1John", "1 John", "1Jn", "1Jn|1 Jn|1Jo"),
    (63, "2John", "2 John", "2Jn", "2Jn|2 Jn|2Jo"),
    (64, "3John", "3 John", "3Jn", "3Jn|3 Jn|3Jo"),
    (65, "Jude", "Jude", "Jud", "Jud|Jd"),
    (66, "Rev", "Revelation", "Rev", "Re|Rv"),
]

SINGLE_CHAPTER = {31, 57, 63, 64, 65}

BY_OSIS = {osis: number for number, osis, _, _, _ in _BOOKS}
BY_STEP = {step: number for number, _, _, step, _ in _BOOKS}
BY_NET_NAME = {name: number for number, _, name, _, _ in _BOOKS}
BY_NET_NAME["Song of Solomon"] = 22
OSIS = {number: osis for number, osis, _, _, _ in _BOOKS}
NAMES = {number: name for number, _, name, _, _ in _BOOKS}


def verse_id(book, chapter, verse):
    return book * 1_000_000 + chapter * 1_000 + verse


def split_id(vid):
    return vid // 1_000_000, (vid // 1_000) % 1_000, vid % 1_000


def _spellings():
    """Every spelling of every book, mapped to its number (for finding references in prose)."""
    names = {}
    for number, osis, name, step, others in _BOOKS:
        spellings = {osis, name, step}
        # NET note style: "1 Sam", "Exod", ... is the OSIS id with a space after the digit.
        spellings.add(re.sub(r"^(\d)", r"\1 ", osis))
        for other in others.split("|"):
            spellings.add(other)
        if name.startswith(("1 ", "2 ", "3 ")):
            spellings.add(name.replace(" ", ""))
        for spelling in spellings:
            names[spelling] = number
    names["Psalm"] = 19
    return names


SPELLINGS = _spellings()


def format_ref(start, end=None):
    """'John 13:35', 'John 13:35-37', 'Gen 1:31-2:3', 'Jude 12' (the app's abbreviations)."""
    book, c, v = split_id(start)
    abbr = re.sub(r"^(\d)", r"\1 ", OSIS[book])
    head = f"{abbr} {v}" if book in SINGLE_CHAPTER else f"{abbr} {c}:{v}"
    if not end or end == start:
        return head
    _, c2, v2 = split_id(end)
    return f"{head}-{v2}" if c2 == c else f"{head}-{c2}:{v2}"

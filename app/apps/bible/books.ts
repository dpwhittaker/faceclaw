/**
 * The 66 books of the Protestant canon in English order, as the Bible app
 * names and numbers them. Book numbers (1-66) are part of every verse id
 * (see verseId), which the app's database uses as its key.
 *
 * Kept free of NativeScript imports so tests can load it under plain node.
 */

export type BookInfo = {
  /** 1-66, Genesis to Revelation. */
  readonly number: number;
  /** OSIS id, e.g. "Gen", "1Sam", "Song". */
  readonly osis: string;
  /** Full English name, as the book picker spells it. */
  readonly name: string;
  /** Short form for references, e.g. "Gen", "1 Sam", "Song". */
  readonly abbr: string;
  readonly chapters: number;
};

function book(number: number, osis: string, name: string, abbr: string, chapters: number): BookInfo {
  return { number, osis, name, abbr, chapters };
}

export const BOOKS: readonly BookInfo[] = [
  book(1, "Gen", "Genesis", "Gen", 50),
  book(2, "Exod", "Exodus", "Exod", 40),
  book(3, "Lev", "Leviticus", "Lev", 27),
  book(4, "Num", "Numbers", "Num", 36),
  book(5, "Deut", "Deuteronomy", "Deut", 34),
  book(6, "Josh", "Joshua", "Josh", 24),
  book(7, "Judg", "Judges", "Judg", 21),
  book(8, "Ruth", "Ruth", "Ruth", 4),
  book(9, "1Sam", "1 Samuel", "1 Sam", 31),
  book(10, "2Sam", "2 Samuel", "2 Sam", 24),
  book(11, "1Kgs", "1 Kings", "1 Kgs", 22),
  book(12, "2Kgs", "2 Kings", "2 Kgs", 25),
  book(13, "1Chr", "1 Chronicles", "1 Chr", 29),
  book(14, "2Chr", "2 Chronicles", "2 Chr", 36),
  book(15, "Ezra", "Ezra", "Ezra", 10),
  book(16, "Neh", "Nehemiah", "Neh", 13),
  book(17, "Esth", "Esther", "Esth", 10),
  book(18, "Job", "Job", "Job", 42),
  book(19, "Ps", "Psalms", "Ps", 150),
  book(20, "Prov", "Proverbs", "Prov", 31),
  book(21, "Eccl", "Ecclesiastes", "Eccl", 12),
  book(22, "Song", "Song of Songs", "Song", 8),
  book(23, "Isa", "Isaiah", "Isa", 66),
  book(24, "Jer", "Jeremiah", "Jer", 52),
  book(25, "Lam", "Lamentations", "Lam", 5),
  book(26, "Ezek", "Ezekiel", "Ezek", 48),
  book(27, "Dan", "Daniel", "Dan", 12),
  book(28, "Hos", "Hosea", "Hos", 14),
  book(29, "Joel", "Joel", "Joel", 3),
  book(30, "Amos", "Amos", "Amos", 9),
  book(31, "Obad", "Obadiah", "Obad", 1),
  book(32, "Jonah", "Jonah", "Jonah", 4),
  book(33, "Mic", "Micah", "Mic", 7),
  book(34, "Nah", "Nahum", "Nah", 3),
  book(35, "Hab", "Habakkuk", "Hab", 3),
  book(36, "Zeph", "Zephaniah", "Zeph", 3),
  book(37, "Hag", "Haggai", "Hag", 2),
  book(38, "Zech", "Zechariah", "Zech", 14),
  book(39, "Mal", "Malachi", "Mal", 4),
  book(40, "Matt", "Matthew", "Matt", 28),
  book(41, "Mark", "Mark", "Mark", 16),
  book(42, "Luke", "Luke", "Luke", 24),
  book(43, "John", "John", "John", 21),
  book(44, "Acts", "Acts", "Acts", 28),
  book(45, "Rom", "Romans", "Rom", 16),
  book(46, "1Cor", "1 Corinthians", "1 Cor", 16),
  book(47, "2Cor", "2 Corinthians", "2 Cor", 13),
  book(48, "Gal", "Galatians", "Gal", 6),
  book(49, "Eph", "Ephesians", "Eph", 6),
  book(50, "Phil", "Philippians", "Phil", 4),
  book(51, "Col", "Colossians", "Col", 4),
  book(52, "1Thess", "1 Thessalonians", "1 Thess", 5),
  book(53, "2Thess", "2 Thessalonians", "2 Thess", 3),
  book(54, "1Tim", "1 Timothy", "1 Tim", 6),
  book(55, "2Tim", "2 Timothy", "2 Tim", 4),
  book(56, "Titus", "Titus", "Titus", 3),
  book(57, "Phlm", "Philemon", "Phlm", 1),
  book(58, "Heb", "Hebrews", "Heb", 13),
  book(59, "Jas", "James", "Jas", 5),
  book(60, "1Pet", "1 Peter", "1 Pet", 5),
  book(61, "2Pet", "2 Peter", "2 Pet", 3),
  book(62, "1John", "1 John", "1 John", 5),
  book(63, "2John", "2 John", "2 John", 1),
  book(64, "3John", "3 John", "3 John", 1),
  book(65, "Jude", "Jude", "Jude", 1),
  book(66, "Rev", "Revelation", "Rev", 22),
];

/** The book picker's three top boxes: Genesis-Job, Psalms-Malachi, Matthew-Revelation. */
export const BOOK_DIVISIONS: readonly (readonly BookInfo[])[] = [
  BOOKS.slice(0, 18),
  BOOKS.slice(18, 39),
  BOOKS.slice(39),
];

export function bookByNumber(number: number): BookInfo | undefined {
  return BOOKS[number - 1];
}

export function isOldTestament(bookNumber: number): boolean {
  return bookNumber <= 39;
}

/** A verse's key everywhere in the app and its database: BBCCCVVV. */
export function verseId(bookNumber: number, chapter: number, verse: number): number {
  return bookNumber * 1_000_000 + chapter * 1_000 + verse;
}

export type VerseRef = { book: number; chapter: number; verse: number };

export function parseVerseId(id: number): VerseRef {
  return { book: Math.floor(id / 1_000_000), chapter: Math.floor(id / 1_000) % 1_000, verse: id % 1_000 };
}

/** "Gen 1:1", or "Gen 1:1-3" with an end verse in the same chapter, "Gen 1:31-2:3" across chapters. */
export function formatRef(startId: number, endId = startId, style: "abbr" | "name" = "abbr"): string {
  const start = parseVerseId(startId);
  const info = bookByNumber(start.book);
  const bookName = info ? (style === "name" ? info.name : info.abbr) : `Book ${start.book}`;
  const single = info?.chapters === 1;
  const head = single ? `${bookName} ${start.verse}` : `${bookName} ${start.chapter}:${start.verse}`;
  if (endId === startId || endId <= 0) return head;
  const end = parseVerseId(endId);
  if (end.book !== start.book) return `${head}-${formatRef(endId, endId, style)}`;
  if (end.chapter === start.chapter) return `${head}-${end.verse}`;
  return `${head}-${end.chapter}:${end.verse}`;
}

/** "Genesis 1" (or "Obadiah" for a book of one chapter). */
export function formatChapter(bookNumber: number, chapter: number): string {
  const info = bookByNumber(bookNumber);
  if (!info) return `Book ${bookNumber} ${chapter}`;
  return info.chapters === 1 ? info.name : `${info.name} ${chapter}`;
}

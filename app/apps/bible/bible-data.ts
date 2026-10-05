/**
 * The Bible app's view of its database (built off the phone by
 * scripts/bible/build_bible_db.py and pushed into the app's files
 * directory; see bible-store.ts). All reads go through one query function,
 * so tests can run the same code against the real file under node.
 *
 * Verse ids are BBCCCVVV (books.ts verseId) in the NET's (English)
 * versification throughout, including the Septuagint words, which the build
 * maps onto the Hebrew verse they translate.
 *
 * Kept free of NativeScript imports so tests can load it under plain node.
 */
import { verseId } from "./books";

/** Runs one SQL query with positional arguments; rows come back as arrays of cells. */
export type QueryFn = (sql: string, args?: ReadonlyArray<string | number>) => unknown[][];

export type ChapterVerse = {
  id: number;
  verse: number;
  text: string;
  /** A section heading printed before this verse. */
  heading: string | null;
  /** A psalm's superscription (or a speaker label, an acrostic letter) printed before this verse. */
  intro: string | null;
  /** The verse begins a paragraph. */
  paragraph: boolean;
  noteCount: number;
  xrefCount: number;
};

/** A Scripture reference cited inside a note: characters start..end of its body. */
export type NoteRef = { start: number; end: number; id: number; endId: number };

/** Where a note on a verse's heading or superscription is anchored, instead of a text offset. */
export const ON_HEADING = -1;
export const ON_INTRO = -2;

export type VerseNote = {
  /** Where the note's marker sits in the verse text (a character offset), or ON_HEADING / ON_INTRO. */
  marker: number;
  /** tn translator's note, sn study note, tc text-critical note, map. */
  kind: string;
  body: string;
  refs: NoteRef[];
};

export type CrossRef = { id: number; endId: number; votes: number; preview: string };

export type Corpus = "hebrew" | "greek" | "lxx";
const CORPUS_CODES: Record<Corpus, number> = { hebrew: 0, greek: 1, lxx: 2 };
const CORPUS_NAMES: Corpus[] = ["hebrew", "greek", "lxx"];

export type OriginalWord = {
  corpus: Corpus;
  verse: number;
  position: number;
  translit: string;
  /** English for this word in this verse. */
  gloss: string;
  /** STEP's sense-split Strong's number (H0776G), or "" for an untagged word. */
  dstrong: string;
  /** The lexicon entry it belongs to (H0776, H1254A, G3056): the concordance key. */
  lexeme: string;
  /** Morphology code (HC/Td/Ncfsa, V-AAI-3S). */
  morph: string;
};

export type LxxVerse = { ref: string; english: string | null; words: OriginalWord[] };

export type VerseStudy = {
  id: number;
  text: string;
  notes: VerseNote[];
  xrefs: CrossRef[];
  words: OriginalWord[];
  lxx: LxxVerse[];
};

export type MorphInfo = { code: string; short: string; label: string; explanation: string };

/** Everything the word study shows about one word: its sense, its lexicon entries, and how it is used. */
export type WordStudyData = {
  /** STEP's sense of the word (H0776G "land: country/planet"). */
  dstrong: string;
  /** The lexicon entry the sense belongs to (H0776): the concordance key. */
  lexeme: string;
  /** "H" Hebrew, "A" Aramaic, "G" Greek. */
  lang: string;
  /** The dictionary form, transliterated. */
  lemma: string;
  gloss: string;
  /** Part of speech, in words. */
  pos: string;
  /** STEP's definition (BDB's sense outline for Hebrew, Abbott-Smith for Greek). */
  meaning: string;
  meaningRefs: NoteRef[];
  /** Plain Strong's number (H776, G26). */
  strong: string;
  /** Strong's definition and the KJV's renderings. */
  strongs: string;
  /** The full lexicon entry (unabridged BDB, Thayer), its references, and its source's name. */
  full: string;
  fullRefs: NoteRef[];
  fullSource: string;
  /** How many verses the lexeme occurs in. */
  verses: number;
  /** How the word is rendered, commonest first. */
  glosses: Array<{ gloss: string; count: number }>;
  /** STEP's senses of the lexeme, when it has several. */
  senses: Array<{ dstrong: string; gloss: string; count: number }>;
};

export type Occurrence = { id: number; position: number; corpus: Corpus; gloss: string; preview: string };

function str(cell: unknown): string {
  return cell === null || cell === undefined ? "" : String(cell);
}

function num(cell: unknown): number {
  const value = Number(cell);
  return Number.isFinite(value) ? value : 0;
}

export class BibleData {
  private verseCounts: Map<number, number> | null = null;
  private readonly morphCache = new Map<string, MorphInfo | null>();

  constructor(private readonly query: QueryFn) {}

  /** The database's own description (sources, build date), for the about page. */
  meta(key: string): string {
    return str(this.query("SELECT value FROM meta WHERE key = ?", [key])[0]?.[0]);
  }

  verseCount(book: number, chapter: number): number {
    if (!this.verseCounts) {
      this.verseCounts = new Map();
      for (const [chapterKey, last] of this.query("SELECT id / 1000, MAX(id % 1000) FROM verses GROUP BY id / 1000")) {
        this.verseCounts.set(num(chapterKey), num(last));
      }
    }
    return this.verseCounts.get(book * 1000 + chapter) ?? 0;
  }

  chapter(book: number, chapter: number): ChapterVerse[] {
    const first = verseId(book, chapter, 0);
    return this.query(
      "SELECT id, text, heading, intro, para, note_count, xref_count FROM verses WHERE id BETWEEN ? AND ? ORDER BY id",
      [first, first + 999],
    ).map((row) => ({
      id: num(row[0]),
      verse: num(row[0]) % 1000,
      text: str(row[1]),
      heading: row[2] === null ? null : str(row[2]),
      intro: row[3] === null ? null : str(row[3]),
      paragraph: num(row[4]) !== 0,
      noteCount: num(row[5]),
      xrefCount: num(row[6]),
    }));
  }

  /** The NET text of each verse asked for (missing verses are left out). */
  verseTexts(ids: readonly number[]): Map<number, string> {
    const texts = new Map<number, string>();
    for (let start = 0; start < ids.length; start += 400) {
      const batch = ids.slice(start, start + 400);
      const marks = batch.map(() => "?").join(",");
      for (const row of this.query(`SELECT id, text FROM verses WHERE id IN (${marks})`, batch)) {
        texts.set(num(row[0]), str(row[1]));
      }
    }
    return texts;
  }

  study(id: number): VerseStudy | null {
    const verse = this.query("SELECT text FROM verses WHERE id = ?", [id])[0];
    if (!verse) return null;
    const notes = this.query("SELECT marker, kind, body, refs FROM notes WHERE verse = ? ORDER BY seq", [id]).map(
      (row) => ({ marker: num(row[0]), kind: str(row[1]), body: str(row[2]), refs: parseRefs(str(row[3])) }),
    );
    const xrefRows = this.query("SELECT target, target_end, votes FROM xrefs WHERE verse = ? ORDER BY seq", [id]);
    const previews = this.verseTexts(xrefRows.map((row) => num(row[0])));
    const xrefs = xrefRows.map((row) => ({
      id: num(row[0]),
      endId: num(row[1]),
      votes: num(row[2]),
      preview: previews.get(num(row[0])) ?? "",
    }));
    const allWords = this.words(id);
    const lxx = this.query("SELECT seq, ref, english FROM lxx WHERE verse = ? ORDER BY seq", [id]).map((row) => ({
      seq: num(row[0]),
      ref: str(row[1]),
      english: row[2] === null ? null : str(row[2]),
    }));
    const lxxWords = allWords.filter((word) => word.corpus === "lxx");
    return {
      id,
      text: str(verse[0]),
      notes,
      xrefs,
      words: allWords.filter((word) => word.corpus !== "lxx"),
      // Words carry their LXX verse in the position's thousands (seq * 1000 + n).
      lxx: lxx.map((entry) => ({
        ref: entry.ref,
        english: entry.english,
        words: lxxWords.filter((word) => Math.floor(word.position / 1000) === entry.seq),
      })),
    };
  }

  private words(id: number): OriginalWord[] {
    return this.query(
      "SELECT corpus, pos, translit, gloss, dstrong, lexeme, morph FROM words WHERE verse = ? ORDER BY corpus, pos",
      [id],
    ).map((row) => ({
      corpus: CORPUS_NAMES[num(row[0])] ?? "hebrew",
      verse: id,
      position: num(row[1]),
      translit: str(row[2]),
      gloss: str(row[3]),
      dstrong: str(row[4]),
      lexeme: str(row[5]),
      morph: str(row[6]),
    }));
  }

  /** Each code's description; a compound Hebrew code (HC/Td/Ncfsa) is described segment by segment. */
  morph(code: string, corpus: Corpus): MorphInfo[] {
    return morphSegments(code, corpus).map((segment) => this.morphSegment(segment) ?? {
      code: segment, short: segment, label: segment, explanation: "",
    });
  }

  private morphSegment(code: string): MorphInfo | null {
    if (this.morphCache.has(code)) return this.morphCache.get(code)!;
    const row = this.query("SELECT code, short, label, explanation FROM morph WHERE code = ?", [code])[0];
    const info = row ? { code: str(row[0]), short: str(row[1]), label: str(row[2]), explanation: str(row[3]) } : null;
    this.morphCache.set(code, info);
    return info;
  }

  /** The word study for a word's sense (falling back to its lexeme's first sense). */
  wordStudy(dstrong: string, lexeme: string): WordStudyData | null {
    const columns = "SELECT dstrong, lexeme, lang, lemma, gloss, pos, meaning, meaning_refs, strong FROM lexicon";
    const row = this.query(`${columns} WHERE dstrong = ?`, [dstrong])[0] ??
      this.query(`${columns} WHERE lexeme = ? ORDER BY dstrong LIMIT 1`, [lexeme])[0];
    if (!row) return null;
    const strong = str(row[8]);
    const entry = this.query("SELECT source, text, refs, strongs FROM entries WHERE strong = ?", [strong])[0];
    const stats = this.query("SELECT verses, glosses, senses FROM lexemes WHERE lexeme = ?", [str(row[1])])[0];
    return {
      dstrong: str(row[0]),
      lexeme: str(row[1]),
      lang: str(row[2]),
      lemma: str(row[3]),
      gloss: str(row[4]),
      pos: str(row[5]),
      meaning: str(row[6]),
      meaningRefs: parseRefs(str(row[7])),
      strong,
      strongs: str(entry?.[3]),
      full: str(entry?.[1]),
      fullRefs: parseRefs(str(entry?.[2])),
      fullSource: str(entry?.[0]),
      verses: num(stats?.[0]),
      glosses: parseJson<Array<[string, number]>>(str(stats?.[1]), []).map(([gloss, count]) => ({ gloss, count })),
      senses: parseJson<Array<[string, string, number]>>(str(stats?.[2]), []).map(([sense, gloss, count]) => ({
        dstrong: sense, gloss, count,
      })),
    };
  }

  /** Where a word occurs, in canonical order (the Septuagint after the Hebrew and Greek texts), a page at a time. */
  occurrences(lexeme: string, offset: number, limit: number, corpus?: Corpus): Occurrence[] {
    const filter = corpus === undefined ? "" : " AND w.corpus = ?";
    const args: Array<string | number> = corpus === undefined ? [lexeme, limit, offset] : [lexeme, CORPUS_CODES[corpus], limit, offset];
    return this.query(
      "SELECT w.verse, w.pos, w.corpus, w.gloss, v.text FROM words w LEFT JOIN verses v ON v.id = w.verse " +
        `WHERE w.lexeme = ?${filter} ORDER BY w.corpus = 2, w.verse, w.pos LIMIT ? OFFSET ?`,
      args,
    ).map((row) => ({
      id: num(row[0]),
      position: num(row[1]),
      corpus: CORPUS_NAMES[num(row[2])] ?? "hebrew",
      gloss: str(row[3]),
      preview: str(row[4]),
    }));
  }

  /** How many times a word occurs in each corpus. */
  occurrenceCounts(lexeme: string): Map<Corpus, number> {
    const counts = new Map<Corpus, number>();
    for (const row of this.query("SELECT corpus, COUNT(*) FROM words WHERE lexeme = ? GROUP BY corpus", [lexeme])) {
      counts.set(CORPUS_NAMES[num(row[0])] ?? "hebrew", num(row[1]));
    }
    return counts;
  }
}

/** A Hebrew code's segments with the language letter on each (HC/Td/Ncfsa: HC, HTd, HNcfsa); Greek codes are whole. */
export function morphSegments(code: string, corpus: Corpus): string[] {
  if (!code) return [];
  if (corpus !== "hebrew") return [code];
  const lang = code[0]!;
  return code.slice(1).split("/").filter((segment) => segment.length > 0).map((segment) => lang + segment);
}

function parseJson<T>(raw: string, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseRefs(raw: string): NoteRef[] {
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as number[][]).map(([start, end, id, endId]) => ({
      start: start!, end: end!, id: id!, endId: endId ?? id!,
    }));
  } catch {
    return [];
  }
}

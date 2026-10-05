import { type BibleData, type Corpus, type Occurrence, type OriginalWord, type WordStudyData } from "./bible-data";
import { formatRef } from "./books";
import { type StudyBlock } from "./study-document";
import { linkedParagraphs, type OpenReading, StudyPage } from "./study-page";

/** Occurrences loaded at a time. */
const PAGE = 60;
const PREVIEW_CHARS = 100;

const LANGUAGES: Record<string, string> = { H: "Hebrew", A: "Aramaic", G: "Greek" };
const CORPUS_LABELS: Record<Corpus, string> = { hebrew: "Old Testament", greek: "New Testament", lxx: "Septuagint" };

export type WordStudyHooks = {
  data: BibleData;
  openReading: OpenReading;
};

/**
 * One word, studied: what it is here (its parsing, explained in plain
 * words), what it means (STEP's definition, Strong's, and the full lexicon
 * entry, folded), how it is translated across Scripture, and every verse it
 * occurs in, each a link to the reading view. Greek words list their uses in
 * the New Testament and the Septuagint separately.
 */
export class WordStudyLayer extends StudyPage {
  private readonly entry: WordStudyData | null;
  private readonly counts: Map<Corpus, number>;
  private readonly loaded = new Map<Corpus, Occurrence[]>();

  constructor(private readonly word: OriginalWord, private readonly hooks: WordStudyHooks) {
    super();
    this.entry = hooks.data.wordStudy(word.dstrong, word.lexeme);
    const lexeme = this.entry?.lexeme ?? word.lexeme;
    this.counts = lexeme ? hooks.data.occurrenceCounts(lexeme) : new Map();
  }

  protected title(): string {
    const entry = this.entry;
    return entry ? `${entry.lemma} · ${entry.dstrong}` : this.word.translit;
  }

  protected buildBlocks(): StudyBlock[] {
    const entry = this.entry;
    const word = this.word;
    const open = this.hooks.openReading;
    const blocks: StudyBlock[] = [];
    if (!entry) {
      blocks.push({ runs: [{ text: `${word.translit}  ${word.gloss}`, tone: "bright" }] });
      blocks.push({ runs: [{ text: "No lexicon entry for this word.", tone: "dim" }] });
      return blocks;
    }
    blocks.push({
      size: "medium",
      runs: [{ text: entry.lemma, tone: "bright" }, { text: `  ${entry.gloss}`, tone: "body" }],
    });
    blocks.push({
      spaceBefore: 2,
      runs: [{ text: [LANGUAGES[entry.lang] ?? entry.lang, entry.pos, entry.strong].filter(Boolean).join(" · "), tone: "faint" }],
    });

    // This occurrence: the form, its English here, and its parsing explained.
    blocks.push(this.sectionHeading("here", `In ${formatRef(word.verse)}`, "", true));
    if (this.isOpen("here", true)) {
      blocks.push({ spaceBefore: 4, runs: [{ text: word.translit, tone: "bright" }, { text: `  ${word.gloss}`, tone: "body" }] });
      for (const morph of this.hooks.data.morph(word.morph, word.corpus)) {
        blocks.push({ spaceBefore: 4, runs: [{ text: morph.label || morph.short, tone: "body" }] });
        if (morph.explanation) {
          blocks.push({ spaceBefore: 1, indent: 10, runs: [{ text: plainCase(morph.explanation), tone: "dim" }] });
        }
      }
    }

    if (entry.meaning) {
      blocks.push(this.sectionHeading("meaning", "Meaning", entry.lang === "G" ? "Abbott-Smith" : "BDB outline", true));
      if (this.isOpen("meaning", true)) blocks.push(...linkedParagraphs(entry.meaning, entry.meaningRefs, open, "meaning"));
    }
    if (entry.strongs) {
      blocks.push(this.sectionHeading("strongs", "Strong's", entry.strong, true));
      if (this.isOpen("strongs", true)) blocks.push(...linkedParagraphs(entry.strongs, [], open, "strongs"));
    }
    if (entry.full) {
      blocks.push(this.sectionHeading("full", "Full entry", entry.fullSource, false));
      if (this.isOpen("full", false)) blocks.push(...linkedParagraphs(entry.full, entry.fullRefs, open, "full"));
    }
    if (entry.senses.length > 1) {
      blocks.push(this.sectionHeading("senses", "Senses", `${entry.senses.length}`, true));
      if (this.isOpen("senses", true)) {
        for (const sense of entry.senses) {
          blocks.push({
            spaceBefore: 3,
            runs: [
              { text: sense.gloss || sense.dstrong, tone: sense.dstrong === entry.dstrong ? "bright" : "body" },
              { text: `  ${sense.count}×  ${sense.dstrong}`, tone: "faint" },
            ],
          });
        }
      }
    }
    if (entry.glosses.length) {
      blocks.push(this.sectionHeading("glosses", "Translated as", "", true));
      if (this.isOpen("glosses", true)) {
        blocks.push({
          spaceBefore: 4,
          runs: [{ text: entry.glosses.slice(0, 24).map((g) => `${g.gloss} (${g.count})`).join(" · "), tone: "body" }],
        });
      }
    }
    for (const corpus of ["hebrew", "greek", "lxx"] as const) this.addOccurrences(blocks, corpus);
    return blocks;
  }

  private addOccurrences(blocks: StudyBlock[], corpus: Corpus): void {
    const total = this.counts.get(corpus) ?? 0;
    if (!total) return;
    const lexeme = this.entry!.lexeme;
    const verses = corpus === "lxx" ? "" : ` · ${this.entry!.verses} verses`;
    blocks.push(this.sectionHeading(`uses:${corpus}`, CORPUS_LABELS[corpus], `${total}×${corpus === "lxx" ? "" : verses}`, corpus !== "lxx"));
    if (!this.isOpen(`uses:${corpus}`, corpus !== "lxx")) return;
    let list = this.loaded.get(corpus);
    if (!list) {
      list = this.hooks.data.occurrences(lexeme, 0, PAGE, corpus);
      this.loaded.set(corpus, list);
    }
    for (const use of list) {
      const preview = use.preview.replace(/\n/g, " ");
      const here = use.id === this.word.verse && use.position === this.word.position && use.corpus === this.word.corpus;
      blocks.push({
        spaceBefore: 5,
        runs: [
          { text: formatRef(use.id), tone: "link" },
          { text: `  ${use.gloss}`, tone: here ? "bright" : "body" },
          { text: `  ${preview.length > PREVIEW_CHARS ? `${preview.slice(0, PREVIEW_CHARS).trimEnd()}…` : preview}`, tone: "faint" },
        ],
        action: { key: `use:${corpus}:${use.id}:${use.position}`, run: (ctx) => this.hooks.openReading(use.id, ctx) },
      });
    }
    if (list.length < total) {
      blocks.push({
        spaceBefore: 6,
        runs: [{ text: `Show ${Math.min(PAGE, total - list.length)} more of ${total - list.length}`, tone: "link" }],
        action: {
          key: `use:${corpus}:more:${list.length}`,
          run: () => {
            list!.push(...this.hooks.data.occurrences(lexeme, list!.length, PAGE, corpus));
            this.rebuild();
          },
        },
      });
    }
  }
}

/** STEP's explanations shout their key words ("an ACTION OR ACTIVITY"); bring them down to sentence case. */
function plainCase(text: string): string {
  return text.replace(/\b[A-Z]{2,}(?:\s+[A-Z]{2,})*\b/g, (word) => word.toLowerCase());
}

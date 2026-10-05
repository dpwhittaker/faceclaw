import { type LayerContext } from "../../ui/layers";
import {
  type BibleData,
  type OriginalWord,
  ON_HEADING,
  ON_INTRO,
  type VerseStudy,
} from "./bible-data";
import { formatRef, isOldTestament, parseVerseId } from "./books";
import { type StudyBlock, type StudyRun } from "./study-document";
import { linkedRuns, type OpenReading, StudyPage } from "./study-page";

/** Cross-references listed before "Show all". */
const XREFS_SHOWN = 8;
const PREVIEW_CHARS = 110;

const NOTE_KINDS: Record<string, string> = {
  tn: "Translator's note",
  sn: "Study note",
  tc: "Text-critical note",
  map: "Map",
};

export type VerseStudyHooks = {
  data: BibleData;
  openReading: OpenReading;
  openWord: (word: OriginalWord, ctx: LayerContext) => void;
};

/**
 * Everything about one verse, on one page: the NET text with its note
 * markers, the translators' notes (references in them are links), the
 * cross-references, the Hebrew or Greek word by word, and for the Old
 * Testament the Septuagint's rendering of the verse word by word. A
 * reference opens the reading view there; a word opens its word study.
 */
export class VerseStudyLayer extends StudyPage {
  private readonly study: VerseStudy | null;
  private allXrefs = false;

  constructor(private readonly verseId: number, private readonly hooks: VerseStudyHooks) {
    super();
    this.study = hooks.data.study(verseId);
  }

  protected title(): string {
    return `${formatRef(this.verseId, this.verseId, "name")} · NET`;
  }

  protected buildBlocks(): StudyBlock[] {
    const study = this.study;
    if (!study) return [{ runs: [{ text: "This verse isn't in the Bible database.", tone: "dim" }] }];
    const blocks: StudyBlock[] = [];
    const chapter = this.hooks.data.chapter(parseVerseId(this.verseId).book, parseVerseId(this.verseId).chapter);
    const verse = chapter.find((v) => v.id === this.verseId);

    // Note numbers in marker order, shared by the typed notes under one marker.
    const numbers = new Map<number, number>();
    for (const note of study.notes) {
      if (!numbers.has(note.marker)) numbers.set(note.marker, numbers.size + 1);
    }
    const marker = (at: number): StudyRun[] =>
      numbers.has(at) ? [{ text: String(numbers.get(at)), tone: "dim", size: "small" }] : [];

    if (verse?.heading) blocks.push({ runs: [{ text: verse.heading, tone: "dim" }, ...marker(ON_HEADING)] });
    if (verse?.intro) blocks.push({ runs: [{ text: verse.intro, tone: "dim" }, ...marker(ON_INTRO)] });
    blocks.push({ size: "medium", spaceBefore: 4, runs: this.markedText(study.text, numbers) });

    this.addNotes(blocks, study, numbers);
    this.addXrefs(blocks, study);
    this.addWords(blocks, study.words, isOldTestament(parseVerseId(this.verseId).book) ? "Hebrew" : "Greek", "words");
    if (study.lxx.length) this.addLxx(blocks, study);
    return blocks;
  }

  /** The verse with each note's number after the words it annotates. */
  private markedText(text: string, numbers: Map<number, number>): StudyRun[] {
    const runs: StudyRun[] = [];
    let pos = 0;
    const offsets = [...numbers.keys()].filter((at) => at >= 0).sort((a, b) => a - b);
    for (const at of offsets) {
      if (at > pos) runs.push({ text: text.slice(pos, at), tone: "bright" });
      runs.push({ text: String(numbers.get(at)), tone: "dim", size: "small" });
      pos = at;
    }
    if (pos < text.length) runs.push({ text: text.slice(pos), tone: "bright" });
    return runs;
  }

  private addNotes(blocks: StudyBlock[], study: VerseStudy, numbers: Map<number, number>): void {
    if (!study.notes.length) return;
    blocks.push(this.sectionHeading("notes", "Notes", `${study.notes.length}`, true));
    if (!this.isOpen("notes", true)) return;
    study.notes.forEach((note, index) => {
      const number = numbers.get(note.marker) ?? 0;
      const where = note.marker === ON_HEADING ? " (heading)" : note.marker === ON_INTRO ? " (superscription)" : "";
      blocks.push({
        spaceBefore: 8,
        hangingIndent: 0,
        runs: [
          { text: `${number}  `, tone: "dim" },
          { text: `${NOTE_KINDS[note.kind] ?? "Note"}${where}: `, tone: "faint" },
          ...linkedRuns(note.body, note.refs, this.hooks.openReading, `note:${index}`),
        ],
      });
    });
  }

  private addXrefs(blocks: StudyBlock[], study: VerseStudy): void {
    if (!study.xrefs.length) return;
    blocks.push(this.sectionHeading("xrefs", "Cross-references", `${study.xrefs.length}`, true));
    if (!this.isOpen("xrefs", true)) return;
    const shown = this.allXrefs ? study.xrefs : study.xrefs.slice(0, XREFS_SHOWN);
    for (const xref of shown) {
      const preview = xref.preview.replace(/\n/g, " ");
      blocks.push({
        spaceBefore: 6,
        runs: [
          { text: formatRef(xref.id, xref.endId), tone: "link" },
          { text: `  ${preview.length > PREVIEW_CHARS ? `${preview.slice(0, PREVIEW_CHARS).trimEnd()}…` : preview}`, tone: "dim" },
        ],
        action: { key: `xref:${xref.id}:${xref.endId}`, run: (ctx) => this.hooks.openReading(xref.id, ctx) },
      });
    }
    if (!this.allXrefs && study.xrefs.length > XREFS_SHOWN) {
      blocks.push({
        spaceBefore: 6,
        runs: [{ text: `Show all ${study.xrefs.length}`, tone: "link" }],
        action: {
          key: "xref:all",
          run: () => {
            this.allXrefs = true;
            this.rebuild();
          },
        },
      });
    }
  }

  private addWords(blocks: StudyBlock[], words: OriginalWord[], language: string, section: string, label = language): void {
    if (!words.length) return;
    blocks.push(this.sectionHeading(section, label, `${words.length} words`, true));
    if (!this.isOpen(section, true)) return;
    for (const word of words) blocks.push(this.wordBlock(word));
  }

  private wordBlock(word: OriginalWord): StudyBlock {
    const parse = this.hooks.data.morph(word.morph, word.corpus).map((m) => m.short).join(" + ");
    const studyable = word.lexeme !== "" || word.dstrong !== "";
    return {
      spaceBefore: 5,
      hangingIndent: 16,
      runs: [
        { text: word.translit || "—", tone: "bright" },
        { text: `  ${word.gloss}`, tone: "body" },
        { text: `  ${[parse, word.dstrong].filter(Boolean).join(" · ")}`, tone: "faint" },
      ],
      action: studyable
        ? { key: `word:${word.corpus}:${word.position}`, run: (ctx) => this.hooks.openWord(word, ctx) }
        : undefined,
    };
  }

  private addLxx(blocks: StudyBlock[], study: VerseStudy): void {
    const count = study.lxx.reduce((sum, verse) => sum + verse.words.length, 0);
    blocks.push(this.sectionHeading("lxx", "Septuagint", `${count} words`, true));
    if (!this.isOpen("lxx", true)) return;
    for (const verse of study.lxx) {
      blocks.push({ spaceBefore: 6, runs: [{ text: `LXX ${verse.ref}`, tone: "dim" }] });
      if (verse.english) blocks.push({ spaceBefore: 2, runs: [{ text: verse.english, tone: "body" }] });
      for (const word of verse.words) blocks.push(this.wordBlock(word));
    }
  }
}

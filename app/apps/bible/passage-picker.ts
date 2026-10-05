/**
 * The Bible app's passage picker, as state: book, then chapter, then verse,
 * each a three-way tree (trinary-tree.ts). Swipe up / tap / swipe down enter
 * a box; a box of one item picks it and moves on to the next phase; double-tap
 * zooms out, then steps back a phase (to its outermost level), then leaves.
 *
 * Kept free of NativeScript imports so tests can load it under plain node.
 */
import { BOOK_DIVISIONS, bookByNumber, type BookInfo, type VerseRef } from "./books";
import {
  group,
  leaf,
  numberTree,
  PickCursor,
  type PickLeaf,
  type PickNode,
  type Slot,
  splitThirds,
} from "./trinary-tree";

/** A book leaf carries its short form, for when the full name can't fit. */
export type BookLeaf = PickLeaf<number> & { readonly short: string };

function bookLeaf(info: BookInfo): BookLeaf {
  return { ...leaf(info.name, info.number), short: info.abbr };
}

/** Genesis-Job, Psalms-Malachi, Matthew-Revelation, each split in thirds below. */
export const BOOK_TREE: PickNode<number> = group(
  BOOK_DIVISIONS.map((division) => splitThirds(division.map(bookLeaf))),
);

export type PickerPhase =
  | { kind: "book" }
  | { kind: "chapter"; book: number }
  | { kind: "verse"; book: number; chapter: number };

/** What the picker needs to know about the text: how many verses each chapter has. */
export type VerseCounts = (book: number, chapter: number) => number;

export type PickerOutcome =
  | { kind: "moved" }
  | { kind: "picked"; ref: VerseRef }
  | { kind: "exit" }
  | { kind: "none" };

export class PassagePicker {
  private phase: PickerPhase = { kind: "book" };
  private cursor: PickCursor<number> = new PickCursor(BOOK_TREE);

  constructor(private readonly verseCounts: VerseCounts) {}

  getPhase(): PickerPhase {
    return this.phase;
  }

  getCursor(): PickCursor<number> {
    return this.cursor;
  }

  /** Jump straight to choosing a verse of this chapter (resuming, or after picking one). */
  showVerses(book: number, chapter: number): void {
    this.setPhase({ kind: "verse", book, chapter });
  }

  /** Back to the outermost level of choosing a book. */
  reset(): void {
    this.setPhase({ kind: "book" });
  }

  enter(slot: Slot): PickerOutcome {
    const outcome = this.cursor.enter(slot);
    if (outcome.kind !== "picked") return outcome;
    return this.picked(outcome.value);
  }

  /** Double-tap: zoom out; at a phase's outermost level, the phase before; at the books', exit. */
  back(): PickerOutcome {
    if (this.cursor.back()) return { kind: "moved" };
    const phase = this.phase;
    if (phase.kind === "verse") {
      const info = bookByNumber(phase.book);
      this.setPhase(info && info.chapters > 1 ? { kind: "chapter", book: phase.book } : { kind: "book" });
      return { kind: "moved" };
    }
    if (phase.kind === "chapter") {
      this.setPhase({ kind: "book" });
      return { kind: "moved" };
    }
    return { kind: "exit" };
  }

  private picked(value: number): PickerOutcome {
    const phase = this.phase;
    if (phase.kind === "book") {
      const info = bookByNumber(value);
      if (!info) return { kind: "none" };
      if (info.chapters > 1) {
        this.setPhase({ kind: "chapter", book: value });
        return { kind: "moved" };
      }
      return this.pickedChapter(value, 1);
    }
    if (phase.kind === "chapter") return this.pickedChapter(phase.book, value);
    // A verse: the picker waits at this chapter's verses for the wearer's return.
    this.cursor = new PickCursor(this.cursor.root);
    return { kind: "picked", ref: { book: phase.book, chapter: phase.chapter, verse: value } };
  }

  private pickedChapter(book: number, chapter: number): PickerOutcome {
    this.setPhase({ kind: "verse", book, chapter });
    // A chapter of one verse needs no choice.
    if (this.cursor.root.kind === "leaf") {
      return { kind: "picked", ref: { book, chapter, verse: this.cursor.root.value } };
    }
    return { kind: "moved" };
  }

  private setPhase(phase: PickerPhase): void {
    this.phase = phase;
    this.cursor = new PickCursor(this.treeFor(phase));
  }

  private treeFor(phase: PickerPhase): PickNode<number> {
    switch (phase.kind) {
      case "book":
        return BOOK_TREE;
      case "chapter":
        return numberTree(1, bookByNumber(phase.book)?.chapters ?? 1);
      case "verse":
        return numberTree(1, Math.max(1, this.verseCounts(phase.book, phase.chapter)));
    }
  }
}

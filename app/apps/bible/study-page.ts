import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, gestureHints, type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { RingSwipeFilter } from "../../ui/ring-swipe-filter";
import { type NoteRef } from "./bible-data";
import { StudyDocument, type StudyBlock, type StudyRun, type Tone } from "./study-document";

const MARGIN_X = 14;
const TOP = 4;

/** Opens the reading view at a verse (a reference followed from a study page). */
export type OpenReading = (verseId: number, ctx: LayerContext) => void;

/**
 * A page of study material (a verse's notes and words, a word's lexicon
 * entry and uses) on the ring: a StudyDocument under a title line, with the
 * gesture hints below. Swipes move block by block, and a quick swipe that
 * the R1 reports several times moves several blocks, as in the system menus;
 * inside a block's references each swipe moves exactly one. Tap opens the
 * block or steps into its references; double-tap steps back out, then goes
 * back. Sections fold: tapping a heading opens or closes it.
 */
export abstract class StudyPage implements Layer {
  protected readonly doc = new StudyDocument();
  /** Sections the wearer has opened or closed (relative to each section's default). */
  private readonly toggled = new Set<string>();
  private readonly swipeFilter = new RingSwipeFilter();
  private built = false;

  protected abstract title(): string;
  protected abstract buildBlocks(): StudyBlock[];

  /**
   * Rebuild the page (after a section opens or more items load), keeping the
   * focus on the same block, or at its place when it is gone ("Show more"
   * gives way to the first of what it loaded).
   */
  protected rebuild(): void {
    const key = this.doc.focusedKey();
    const index = this.doc.focusedIndex();
    this.doc.setBlocks(this.buildBlocks());
    this.doc.focusOn(key, index);
  }

  protected isOpen(section: string, openByDefault: boolean): boolean {
    return this.toggled.has(section) ? !openByDefault : openByDefault;
  }

  /** A section's heading: a stop that opens or closes it. */
  protected sectionHeading(section: string, label: string, detail: string, openByDefault: boolean): StudyBlock {
    const open = this.isOpen(section, openByDefault);
    return {
      spaceBefore: 12,
      rule: true,
      runs: [
        { text: `${open ? "−" : "+"} ${label}`, tone: "bright" },
        ...(detail ? [{ text: `  ${detail}`, tone: "faint" as Tone }] : []),
      ],
      action: {
        key: `section:${section}`,
        run: () => {
          if (this.toggled.has(section)) this.toggled.delete(section);
          else this.toggled.add(section);
          this.rebuild();
        },
      },
    };
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    // The filter sees every event (it learns from ring-press), but only
    // steps through references need one step per swipe.
    const fresh = this.swipeFilter.accept(event);
    if (event.type === "ring-press" || (!fresh && this.doc.inLinks())) return;
    switch (event.type) {
      case "scroll-down":
        this.doc.moveDown();
        return;
      case "scroll-up":
        this.doc.moveUp();
        return;
      case "click":
        this.doc.activate(ctx);
        return;
      case "double-click":
        if (this.doc.inLinks()) this.doc.leaveLinks();
        else ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  paint(ctx: LayerContext): GrayImage {
    if (!this.built) {
      this.built = true;
      this.doc.setBlocks(this.buildBlocks());
    }
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const headerHeight = small.lineHeight + 8;
    const footerY = height - small.lineHeight - 3;
    const viewHeight = footerY - 6 - headerHeight;
    const docWidth = width - 2 * MARGIN_X - 6;
    this.doc.layout({ small, medium }, docWidth, viewHeight);

    image.drawText(small, MARGIN_X, TOP, truncateText(small, this.title(), width - 2 * MARGIN_X), 215);
    this.doc.paint(image, MARGIN_X, headerHeight, docWidth);

    const { position, visible } = this.doc.scrollFraction();
    if (visible < 1) {
      const trackX = width - 5;
      image.fillRect(trackX, headerHeight, 2, viewHeight, 30);
      const thumb = Math.max(10, Math.round(viewHeight * visible));
      image.fillRect(trackX, headerHeight + Math.round((viewHeight - thumb) * position), 2, thumb, 120);
    }
    const tap = this.doc.tapMeaning();
    const hints = gestureHints([
      ...(tap === "none" ? [] : [[GESTURE_CLICK, tap === "links" ? "references" : "open"] as [string, string]]),
      [GESTURE_DOUBLE_CLICK, this.doc.inLinks() ? "done" : "back"],
    ]);
    image.drawText(small, Math.round(width - MARGIN_X - small.measureText(hints)), footerY, hints, 110);
    return image;
  }
}

/**
 * Prose with references in it as runs: plain stretches in `tone`, each
 * reference a stop that opens the reading view there.
 */
export function linkedRuns(
  text: string,
  refs: readonly NoteRef[],
  openReading: OpenReading,
  keyPrefix: string,
  tone: Tone = "body",
): StudyRun[] {
  const runs: StudyRun[] = [];
  let pos = 0;
  for (const ref of refs) {
    if (ref.start < pos || ref.end > text.length) continue;
    if (ref.start > pos) runs.push({ text: text.slice(pos, ref.start), tone });
    runs.push({
      text: text.slice(ref.start, ref.end),
      action: { key: `${keyPrefix}:${ref.start}`, run: (ctx) => openReading(ref.id, ctx) },
    });
    pos = ref.end;
  }
  if (pos < text.length) runs.push({ text: text.slice(pos), tone });
  return runs;
}

/** Split prose with references into one block per paragraph (a blank line or newline in the source). */
export function linkedParagraphs(
  text: string,
  refs: readonly NoteRef[],
  openReading: OpenReading,
  keyPrefix: string,
  tone: Tone = "body",
  indent = 0,
): StudyBlock[] {
  const blocks: StudyBlock[] = [];
  let start = 0;
  for (const piece of text.split("\n")) {
    const end = start + piece.length;
    if (piece.trim()) {
      const local = refs
        .filter((ref) => ref.start >= start && ref.end <= end)
        .map((ref) => ({ ...ref, start: ref.start - start, end: ref.end - start }));
      blocks.push({ runs: linkedRuns(piece, local, openReading, `${keyPrefix}:${start}`, tone), indent, spaceBefore: 4 });
    }
    start = end + 1;
  }
  return blocks;
}

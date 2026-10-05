import { GrayImage, type UiFont } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, gestureHints, type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { lineStep } from "../../ui/metrics";
import { RingSwipeFilter } from "../../ui/ring-swipe-filter";
import { type BibleData, type ChapterVerse } from "./bible-data";
import { BOOKS, bookByNumber, formatChapter, formatRef, type VerseRef } from "./books";

const MARGIN_X = 12;
const TOP = 4;
/** Space between verses, and the extra before a paragraph or heading. */
const VERSE_GAP = 6;
const PARAGRAPH_GAP = 6;
const HEADING_GAP = 10;
/** Poetry lines after the first of a verse sit this much further in. */
const POETRY_INDENT = 14;

const TEXT_VALUE = 200;
const SELECTED_VALUE = 255;
const NUMBER_VALUE = 120;
const HEADING_VALUE = 175;
const INTRO_VALUE = 150;

export type ReadingHooks = {
  data: BibleData;
  /** Tap: the selected verse's study page. */
  openStudy: (verseId: number, ctx: LayerContext) => void;
  /** The selected verse changed (to remember where the reader is). */
  onMoved?: (ref: VerseRef) => void;
};

type Line = { x: number; text: string; font: UiFont; role: "text" | "number" | "heading" | "intro"; dy: number };

const ROLE_VALUE = { text: TEXT_VALUE, number: NUMBER_VALUE, heading: HEADING_VALUE, intro: INTRO_VALUE } as const;
type Block = {
  /** Index into verses, or -1 for a heading or superscription. */
  verse: number;
  top: number;
  height: number;
  lines: Line[];
};

/**
 * The reading view: a chapter of the NET, a verse to a block with its number
 * in the margin, section headings and psalm superscriptions where the NET
 * prints them, poetry kept to its lines. One verse is outlined; swipes move
 * the outline a verse at a time (on into the next chapter, and back into the
 * one before), scrolling to keep it in view. Tap opens that verse's study
 * page; double-tap goes back.
 */
export class ReadingLayer implements Layer {
  private readonly swipeFilter = new RingSwipeFilter();
  private book: number;
  private chapterNumber: number;
  private verses: ChapterVerse[] = [];
  private selected = 0;
  private scroll = 0;
  private blocks: Block[] = [];
  private layoutKey = "";

  constructor(ref: VerseRef, private readonly hooks: ReadingHooks) {
    this.book = ref.book;
    this.chapterNumber = ref.chapter;
    this.load(ref.chapter, ref.verse);
  }

  /** The verse outlined now. */
  current(): VerseRef {
    return { book: this.book, chapter: this.chapterNumber, verse: this.verses[this.selected]?.verse ?? 1 };
  }

  private load(chapter: number, verse: number | "last"): void {
    this.chapterNumber = chapter;
    this.verses = this.hooks.data.chapter(this.book, chapter);
    const index = verse === "last" ? this.verses.length - 1 : this.verses.findIndex((v) => v.verse >= verse);
    this.selected = Math.max(0, index < 0 ? this.verses.length - 1 : index);
    this.layoutKey = "";
    this.scroll = -1;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (!this.swipeFilter.accept(event)) return;
    switch (event.type) {
      case "scroll-down":
        this.step(1);
        return;
      case "scroll-up":
        this.step(-1);
        return;
      case "click": {
        const verse = this.verses[this.selected];
        if (verse) this.hooks.openStudy(verse.id, ctx);
        return;
      }
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  /** Move the outline a verse, crossing into the neighbouring chapter (and book) at the ends. */
  private step(direction: 1 | -1): void {
    const next = this.selected + direction;
    if (next >= 0 && next < this.verses.length) {
      this.selected = next;
    } else if (direction > 0) {
      const info = bookByNumber(this.book);
      if (info && this.chapterNumber < info.chapters) this.load(this.chapterNumber + 1, 1);
      else if (this.book < BOOKS.length) {
        this.book += 1;
        this.load(1, 1);
      } else return;
    } else {
      if (this.chapterNumber > 1) this.load(this.chapterNumber - 1, "last");
      else if (this.book > 1) {
        this.book -= 1;
        this.load(bookByNumber(this.book)?.chapters ?? 1, "last");
      } else return;
    }
    this.hooks.onMoved?.(this.current());
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();

    const headerHeight = small.lineHeight + 6;
    const footerHeight = small.lineHeight + 6;
    const viewTop = headerHeight;
    const viewHeight = height - headerHeight - footerHeight;
    this.layout(small, medium, width);
    this.keepSelectedInView(viewHeight);

    image.drawText(small, MARGIN_X, TOP, formatChapter(this.book, this.chapterNumber), 210);
    const net = "NET";
    image.drawText(small, Math.round(width - MARGIN_X - small.measureText(net)), TOP, net, 110);

    for (const block of this.blocks) {
      const top = block.top - this.scroll;
      if (top + block.height <= 0 || top >= viewHeight) continue;
      for (const line of block.lines) {
        const y = viewTop + top + line.dy;
        // Lines cut by the edges are left out rather than spilling onto the header or footer.
        if (y < viewTop || y + line.font.lineHeight > viewTop + viewHeight) continue;
        const value = line.role === "text" && block.verse === this.selected ? SELECTED_VALUE : ROLE_VALUE[line.role];
        image.drawText(line.font, Math.round(line.x), Math.round(y), line.text, value);
      }
      if (block.verse === this.selected) {
        const boxTop = Math.max(viewTop - 1, viewTop + top - 3);
        const boxBottom = Math.min(viewTop + viewHeight + 1, viewTop + top + block.height + 3);
        image.drawRoundedRect(MARGIN_X - 6, boxTop, width - 2 * MARGIN_X + 12, boxBottom - boxTop, 170, 6);
      }
    }
    this.paintFooter(image, small, width, height - small.lineHeight - 3);
    return image;
  }

  private paintFooter(image: GrayImage, font: UiFont, width: number, y: number): void {
    const verse = this.verses[this.selected];
    if (!verse) return;
    const counts: string[] = [];
    if (verse.noteCount) counts.push(`${verse.noteCount} note${verse.noteCount === 1 ? "" : "s"}`);
    if (verse.xrefCount) counts.push(`${verse.xrefCount} cross-ref${verse.xrefCount === 1 ? "" : "s"}`);
    const left = [formatRef(verse.id), ...counts].join(" · ");
    const right = gestureHints([[GESTURE_CLICK, "study"], [GESTURE_DOUBLE_CLICK, "back"]]);
    const rightWidth = font.measureText(right);
    image.drawText(font, MARGIN_X, y, truncateText(font, left, width - 2 * MARGIN_X - rightWidth - 12), 170);
    image.drawText(font, Math.round(width - MARGIN_X - rightWidth), y, right, 110);
  }

  private keepSelectedInView(viewHeight: number): void {
    const block = this.blocks.find((b) => b.verse === this.selected);
    if (!block) return;
    // Bring along the heading above a verse that has one.
    const index = this.blocks.indexOf(block);
    const lead = index > 0 && this.blocks[index - 1]!.verse < 0 ? this.blocks[index - 1]! : null;
    const wantTop = (lead ?? block).top;
    const margin = 8;
    if (this.scroll < 0) {
      // A fresh chapter: put the verse a little way down, so what leads into it shows.
      this.scroll = Math.max(0, wantTop - Math.round(viewHeight / 4));
    }
    if (wantTop - margin < this.scroll) this.scroll = Math.max(0, wantTop - margin);
    const bottom = block.top + block.height + margin;
    if (bottom > this.scroll + viewHeight) this.scroll = Math.min(wantTop, bottom - viewHeight);
  }

  private layout(small: UiFont, medium: UiFont, width: number): void {
    const key = `${small.fingerprintId}:${medium.fingerprintId}:${width}:${this.book}:${this.chapterNumber}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    const blocks: Block[] = [];
    const gutter = Math.ceil(small.measureText("199")) + 8;
    const textX = MARGIN_X + gutter;
    const textWidth = width - textX - MARGIN_X;
    const step = lineStep(medium);
    let y = 4;
    this.verses.forEach((verse, index) => {
      for (const [kind, text] of [["heading", verse.heading], ["intro", verse.intro]] as const) {
        if (!text) continue;
        if (blocks.length) y += kind === "heading" ? HEADING_GAP : 2;
        const font = small;
        const lines = wrapText(font, text, width - 2 * MARGIN_X).map((line, i) => ({
          x: kind === "heading" ? MARGIN_X : textX,
          text: line,
          font,
          role: kind,
          dy: i * lineStep(font),
        }));
        blocks.push({ verse: -1, top: y, height: lines.length * lineStep(font), lines });
        y += lines.length * lineStep(font) + 2;
      }
      if (index > 0) y += VERSE_GAP + (verse.paragraph ? PARAGRAPH_GAP : 0);
      const lines: Line[] = [];
      verse.text.split("\n").forEach((poetryLine, lineIndex) => {
        const indent = lineIndex > 0 ? POETRY_INDENT : 0;
        for (const wrapped of wrapText(medium, poetryLine, textWidth - indent)) {
          lines.push({ x: textX + indent, text: wrapped, font: medium, role: "text", dy: lines.length * step });
        }
      });
      const number = String(verse.verse);
      lines.unshift({
        x: textX - 8 - small.measureText(number),
        text: number,
        font: small,
        role: "number",
        dy: medium.ascent - small.ascent,
      });
      const height = Math.max(1, lines.length - 1) * step - 2;
      blocks.push({ verse: index, top: y, height, lines });
      y += height;
    });
    this.blocks = blocks;
  }
}

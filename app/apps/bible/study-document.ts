/**
 * A scrolling page of study text for the ring: blocks of styled runs, some of
 * them focus stops (a whole block, like a cross-reference, or a run inside a
 * block, like a reference cited in a note). Swipes move the focus from stop to
 * stop like a browser's tab key, but never scroll more than a page at a time,
 * so a long note between two stops is read on the way rather than jumped
 * over; tap follows the focused stop.
 *
 * Takes its fonts as arguments, so tests can load it under plain node.
 */
import { type GrayImage, type UiFont } from "../../graphics/image";
import { type LayerContext } from "../../ui/layers";

/** Brightness roles for text. */
export type Tone = "bright" | "body" | "dim" | "faint" | "link";

const TONE_VALUE: Record<Tone, number> = { bright: 255, body: 215, dim: 150, faint: 105, link: 235 };

/** What following a stop does; the key keeps the focus on it across rebuilds. */
export type StudyAction = { readonly key: string; readonly run: (ctx: LayerContext) => void };

export type StudyRun = {
  readonly text: string;
  readonly tone?: Tone;
  /** "small" to set a run (a note marker) in the small font inside a medium block. */
  readonly size?: "small" | "medium";
  /** Makes this run a stop of its own. */
  readonly action?: StudyAction;
};

export type StudyBlock = {
  readonly runs: readonly StudyRun[];
  /** The block's font; runs follow it unless they say otherwise. Default small. */
  readonly size?: "small" | "medium";
  /** Left inset of every line, and extra inset of the lines after the first. */
  readonly indent?: number;
  readonly hangingIndent?: number;
  /** Extra space above the block. */
  readonly spaceBefore?: number;
  /** Makes the whole block one stop. */
  readonly action?: StudyAction;
  /** A faint rule above the block (section breaks). */
  readonly rule?: boolean;
};

export type StudyFonts = { small: UiFont; medium: UiFont };

type Fragment = { x: number; y: number; text: string; font: UiFont; value: number; underline: boolean };
type Rect = { x: number; y: number; width: number; height: number };
type Stop = { action: StudyAction; top: number; bottom: number; rects: Rect[]; block: boolean };
type Line = { top: number; bottom: number; fragments: Fragment[] };

/** Gap between lines of a block, and the default gap between blocks. */
const LINE_GAP = 2;
const BLOCK_GAP = 6;

export class StudyDocument {
  private blocks: readonly StudyBlock[] = [];
  private lines: Line[] = [];
  private stops: Stop[] = [];
  private contentHeight = 0;
  private layoutKey = "";
  private scroll = 0;
  private focus = -1;
  private focusKey: string | null = null;
  private viewHeight = 1;

  setBlocks(blocks: readonly StudyBlock[]): void {
    this.blocks = blocks;
    this.layoutKey = "";
  }

  /** The key of the focused stop, if any (to restore after a rebuild). */
  focusedKey(): string | null {
    return this.focus >= 0 ? (this.stops[this.focus]?.action.key ?? null) : this.focusKey;
  }

  /** Focus the stop with this key once laid out (after setBlocks). */
  focusOn(key: string | null): void {
    this.focusKey = key;
    this.focus = -1;
  }

  scrollTop(): number {
    return this.scroll;
  }

  setScrollTop(scroll: number): void {
    this.scroll = scroll;
  }

  /** Lay out for this width and view height (cheap when nothing changed). */
  layout(fonts: StudyFonts, width: number, viewHeight: number): void {
    this.viewHeight = Math.max(1, viewHeight);
    const key = `${fonts.small.fingerprintId}:${fonts.medium.fingerprintId}:${width}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    const previousKey = this.focusedKey();
    this.lines = [];
    this.stops = [];
    const stopByKey = new Map<string, Stop>();
    let y = 0;
    this.blocks.forEach((block, blockIndex) => {
      if (blockIndex > 0) y += block.spaceBefore ?? BLOCK_GAP;
      const blockTop = y;
      if (block.rule) {
        this.lines.push({ top: y, bottom: y + 1, fragments: [{ x: 0, y, text: "", font: fonts.small, value: 0, underline: false }] });
        y += 6;
      }
      y = this.layoutBlock(block, fonts, width, y, stopByKey);
      if (block.action) {
        this.stops.push({ action: block.action, top: blockTop, bottom: y, rects: [], block: true });
      }
    });
    this.contentHeight = y;
    // Inline stops were collected in reading order; merge with block stops by position.
    for (const stop of stopByKey.values()) this.stops.push(stop);
    this.stops.sort((a, b) => a.top - b.top || a.bottom - b.bottom);
    this.focus = previousKey ? this.stops.findIndex((stop) => stop.action.key === previousKey) : -1;
    this.focusKey = null;
    this.scroll = this.clampScroll(this.scroll);
    if (this.focus >= 0) this.scroll = this.scrollToShow(this.stops[this.focus]!);
  }

  private layoutBlock(block: StudyBlock, fonts: StudyFonts, width: number, top: number, stops: Map<string, Stop>): number {
    const blockFont = block.size === "medium" ? fonts.medium : fonts.small;
    const indent = block.indent ?? 0;
    const lineHeight = blockFont.lineHeight;
    let line: Line = { top, bottom: top + lineHeight, fragments: [] };
    let x = indent;
    let lineStart = true;
    const newLine = () => {
      this.lines.push(line);
      const next = line.bottom + LINE_GAP;
      line = { top: next, bottom: next + lineHeight, fragments: [] };
      x = indent + (block.hangingIndent ?? 0);
      lineStart = true;
    };
    for (const run of block.runs) {
      const font = run.size === "small" ? fonts.small : run.size === "medium" ? fonts.medium : blockFont;
      const value = TONE_VALUE[run.tone ?? (run.action ? "link" : "body")];
      // Smaller runs sit on the block's baseline.
      const dy = blockFont.ascent - font.ascent;
      const spaceWidth = font.measureText(" ");
      const tokens = run.text.split(/( +|\n)/).filter((token) => token.length > 0);
      for (const token of tokens) {
        if (token === "\n") {
          newLine();
          continue;
        }
        if (token.startsWith(" ")) {
          if (!lineStart) x += spaceWidth * token.length;
          continue;
        }
        let text = token;
        let tokenWidth = font.measureText(text);
        if (!lineStart && x + tokenWidth > width) newLine();
        // A word wider than the whole line breaks wherever it must.
        while (tokenWidth > width - x && text.length > 1) {
          let cut = text.length - 1;
          while (cut > 1 && font.measureText(text.slice(0, cut)) > width - x) cut--;
          this.place(line, run, font, value, x, dy, text.slice(0, cut), stops);
          text = text.slice(cut);
          tokenWidth = font.measureText(text);
          newLine();
        }
        this.place(line, run, font, value, x, dy, text, stops);
        x += tokenWidth;
        lineStart = false;
      }
    }
    if (line.fragments.length > 0 || !lineStart || block.runs.length === 0) this.lines.push(line);
    else return line.top - LINE_GAP;
    return line.bottom;
  }

  private place(line: Line, run: StudyRun, font: UiFont, value: number, x: number, dy: number, text: string, stops: Map<string, Stop>): void {
    const y = line.top + dy;
    const previous = line.fragments[line.fragments.length - 1];
    const underline = run.action !== undefined;
    // Words of one run on one line draw as one fragment (spaces included).
    if (previous && previous.font === font && previous.value === value && previous.underline === underline &&
        previous.y === y && (previous as Fragment & { run?: StudyRun }).run === run) {
      const gap = x - (previous.x + font.measureText(previous.text));
      const spaces = Math.max(0, Math.round(gap / Math.max(1, font.measureText(" "))));
      previous.text += " ".repeat(spaces) + text;
    } else {
      const fragment: Fragment & { run?: StudyRun } = { x, y, text, font, value, underline, run };
      line.fragments.push(fragment);
    }
    if (run.action) {
      let stop = stops.get(run.action.key);
      if (!stop) {
        stop = { action: run.action, top: line.top, bottom: line.bottom, rects: [], block: false };
        stops.set(run.action.key, stop);
      }
      stop.bottom = Math.max(stop.bottom, line.bottom);
      const width = font.measureText(text);
      const last = stop.rects[stop.rects.length - 1];
      if (last && last.y === line.top && Math.abs(last.x + last.width - x) < font.measureText("  ")) {
        last.width = x + width - last.x;
      } else {
        stop.rects.push({ x, y: line.top, width, height: line.bottom - line.top });
      }
    }
  }

  /** Swipe down: the next stop if it is no more than a page away, else a page further down. */
  moveDown(): void {
    const viewTop = this.scroll;
    const start = this.focus >= 0 && this.stops[this.focus]!.bottom > viewTop ? this.focus + 1 : this.firstStopAtOrBelow(viewTop);
    const next = this.stops[start];
    const page = this.pageStep();
    if (next) {
      const target = Math.max(this.scroll, this.scrollToShow(next));
      if (target - this.scroll <= page) {
        this.focus = start;
        this.scroll = target;
        return;
      }
    }
    this.scroll = this.clampScroll(this.snapDown(this.scroll + page));
  }

  /** Swipe up: the previous stop if it is no more than a page away, else a page further up. */
  moveUp(): void {
    const viewBottom = this.scroll + this.viewHeight;
    const start = this.focus >= 0 && this.stops[this.focus]!.top < viewBottom ? this.focus - 1 : this.lastStopAtOrAbove(viewBottom);
    const previous = start >= 0 ? this.stops[start] : undefined;
    const page = this.pageStep();
    if (previous) {
      const target = Math.min(this.scroll, this.scrollToShow(previous));
      if (this.scroll - target <= page) {
        this.focus = start;
        this.scroll = target;
        return;
      }
    }
    if (this.scroll <= 0) {
      this.focus = -1;
      return;
    }
    this.scroll = this.clampScroll(this.snapUp(this.scroll - page));
  }

  /** Tap: follow the focused stop while it is on screen. False when nothing was followed. */
  activate(ctx: LayerContext): boolean {
    const stop = this.focus >= 0 ? this.stops[this.focus] : undefined;
    if (!stop || stop.bottom <= this.scroll || stop.top >= this.scroll + this.viewHeight) return false;
    stop.action.run(ctx);
    return true;
  }

  hasFocus(): boolean {
    return this.focus >= 0;
  }

  /** Draw the visible lines into (x, y, width, viewHeight); lines cut by the edges are left out. */
  paint(image: GrayImage, x: number, y: number, width: number): void {
    const top = this.scroll;
    const bottom = top + this.viewHeight;
    const focused = this.focus >= 0 ? this.stops[this.focus] : undefined;
    if (focused) {
      if (focused.block) {
        const boxTop = Math.max(focused.top, top) - 3;
        const boxBottom = Math.min(focused.bottom, bottom) + 3;
        image.fillRoundedRect(x - 6, y + boxTop - top, width + 12, boxBottom - boxTop, 18, 6);
        image.drawRoundedRect(x - 6, y + boxTop - top, width + 12, boxBottom - boxTop, 70, 6);
      } else {
        for (const rect of focused.rects) {
          if (rect.y < top || rect.y + rect.height > bottom) continue;
          image.fillRoundedRect(x + rect.x - 3, y + rect.y - top - 1, rect.width + 6, rect.height + 2, 30, 4);
          image.drawRoundedRect(x + rect.x - 3, y + rect.y - top - 1, rect.width + 6, rect.height + 2, 90, 4);
        }
      }
    }
    for (const line of this.lines) {
      if (line.top < top || line.bottom > bottom) continue;
      for (const fragment of line.fragments) {
        if (!fragment.text) {
          image.fillRect(x, y + line.top - top, width, 1, 45);
          continue;
        }
        const fx = Math.round(x + fragment.x);
        const fy = Math.round(y + fragment.y - top);
        image.drawText(fragment.font, fx, fy, fragment.text, fragment.value);
        if (fragment.underline) {
          image.fillRect(fx, fy + fragment.font.ascent + 2, Math.round(fragment.font.measureText(fragment.text)), 1, 80);
        }
      }
    }
  }

  /** How far down the page is, 0..1, and how much of it shows, for a scrollbar. */
  scrollFraction(): { position: number; visible: number } {
    const max = Math.max(1, this.contentHeight - this.viewHeight);
    return {
      position: Math.min(1, this.scroll / max),
      visible: Math.min(1, this.viewHeight / Math.max(1, this.contentHeight)),
    };
  }

  private pageStep(): number {
    // Keep a line or two of what was on screen.
    return Math.max(20, this.viewHeight - 40);
  }

  /** The scroll that shows a stop whole (its top, if it is taller than the view). */
  private scrollToShow(stop: Stop): number {
    let target = this.scroll;
    if (stop.bottom > target + this.viewHeight) target = stop.bottom - this.viewHeight;
    if (stop.top < target) target = stop.top;
    return this.clampScroll(this.snapForTop(target, stop.top));
  }

  /** Snap to a line top so no line is cut, but never past the stop's own top. */
  private snapForTop(target: number, stopTop: number): number {
    const snapped = this.snapUp(target);
    return snapped > stopTop ? this.snapDown(stopTop) : snapped;
  }

  private firstStopAtOrBelow(y: number): number {
    const index = this.stops.findIndex((stop) => stop.top >= y);
    return index < 0 ? this.stops.length : index;
  }

  private lastStopAtOrAbove(y: number): number {
    for (let index = this.stops.length - 1; index >= 0; index--) {
      if (this.stops[index]!.bottom <= y) return index;
    }
    return -1;
  }

  private snapDown(y: number): number {
    let best = 0;
    for (const line of this.lines) {
      if (line.top <= y) best = line.top;
      else break;
    }
    return best;
  }

  private snapUp(y: number): number {
    for (const line of this.lines) {
      if (line.top >= y) return line.top;
    }
    return this.lines.length ? this.lines[this.lines.length - 1]!.top : 0;
  }

  private clampScroll(scroll: number): number {
    const max = Math.max(0, this.contentHeight - this.viewHeight);
    return Math.max(0, Math.min(this.snapUp(max) >= max ? this.snapUp(max) : max, scroll));
  }
}

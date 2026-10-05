/**
 * A scrolling page of study text for the ring, navigated at two levels.
 * Every block (a paragraph, a note, a line of a lexicon's outline, a
 * cross-reference, a word, a section heading) is a stop, outlined like a
 * verse in the reading view; swipes move from block to block. Tapping a
 * block runs its action (open the reference, the word, fold the section);
 * a block of prose follows its one reference, or, when it cites several,
 * steps inside it: then swipes move from reference to reference within it,
 * tap follows one, and leaving (double-tap) returns to the blocks. Neither
 * level ever scrolls more than a page at a time, so a block taller than the
 * screen is read on the way rather than jumped over.
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
  /** Makes this run a link inside its block. */
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
  /** What tapping the block does (otherwise it follows, or steps into, its links). */
  readonly action?: StudyAction;
  /** Identifies the block across rebuilds when it has no action. */
  readonly key?: string;
  /** A faint rule above the block (section breaks). */
  readonly rule?: boolean;
};

export type StudyFonts = { small: UiFont; medium: UiFont };

type Fragment = { x: number; y: number; text: string; font: UiFont; value: number; underline: boolean; run?: StudyRun };
type Rect = { x: number; y: number; width: number; height: number };
/** Something a swipe can land on: its vertical extent. */
type Span = { top: number; bottom: number };
type LinkStop = Span & { action: StudyAction; rects: Rect[] };
type BlockStop = Span & { key: string; action?: StudyAction; links: LinkStop[] };
type Line = { top: number; bottom: number; fragments: Fragment[] };

/** Gap between lines of a block, and the default gap between blocks. */
const LINE_GAP = 2;
const BLOCK_GAP = 6;

export class StudyDocument {
  private blocks: readonly StudyBlock[] = [];
  private lines: Line[] = [];
  private stops: BlockStop[] = [];
  private contentHeight = 0;
  private layoutKey = "";
  private scroll = 0;
  /** The focused block, and the focused link inside it while stepped in (-1 otherwise). */
  private focus = 0;
  private link = -1;
  private restoreKey: string | null = null;
  private restoreIndex = 0;
  private viewHeight = 1;

  setBlocks(blocks: readonly StudyBlock[]): void {
    this.blocks = blocks;
    this.layoutKey = "";
  }

  /** The key of the focused block (to restore after a rebuild). */
  focusedKey(): string | null {
    return this.stops[this.focus]?.key ?? this.restoreKey;
  }

  /** After setBlocks: focus the block with this key once laid out, or failing that the block at `index`. */
  focusOn(key: string | null, index = this.focus): void {
    this.restoreKey = key;
    this.restoreIndex = index;
    this.link = -1;
  }

  focusedIndex(): number {
    return this.focus;
  }

  scrollTop(): number {
    return this.scroll;
  }

  /** Whether swipes are stepping through one block's links. */
  inLinks(): boolean {
    return this.link >= 0;
  }

  /** Back from a block's links to the blocks. */
  leaveLinks(): void {
    this.link = -1;
  }

  /** What tapping now would do: follow a link or a block's action, step into links, or nothing. */
  tapMeaning(): "follow" | "links" | "none" {
    const stop = this.stops[this.focus];
    if (!stop) return "none";
    if (this.link >= 0 || stop.action || stop.links.length === 1) return "follow";
    return stop.links.length > 1 ? "links" : "none";
  }

  /** Lay out for this width and view height (cheap when nothing changed). */
  layout(fonts: StudyFonts, width: number, viewHeight: number): void {
    this.viewHeight = Math.max(1, viewHeight);
    const key = `${fonts.small.fingerprintId}:${fonts.medium.fingerprintId}:${width}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    const restoreKey = this.restoreKey ?? this.stops[this.focus]?.key ?? null;
    const restoreIndex = this.restoreKey !== null ? this.restoreIndex : this.focus;
    const restoreLink = this.restoreKey === null ? this.link : -1;
    this.lines = [];
    this.stops = [];
    let y = 0;
    this.blocks.forEach((block, blockIndex) => {
      if (blockIndex > 0) y += block.spaceBefore ?? BLOCK_GAP;
      const top = y;
      if (block.rule) {
        this.lines.push({ top: y, bottom: y + 1, fragments: [{ x: 0, y, text: "", font: fonts.small, value: 0, underline: false }] });
        y += 6;
      }
      const links = new Map<string, LinkStop>();
      y = this.layoutBlock(block, fonts, width, y, links);
      this.stops.push({
        key: block.action?.key ?? block.key ?? `block:${blockIndex}`,
        action: block.action,
        top,
        bottom: y,
        links: [...links.values()],
      });
    });
    this.contentHeight = y;
    const found = restoreKey ? this.stops.findIndex((stop) => stop.key === restoreKey) : -1;
    this.focus = Math.max(0, Math.min(this.stops.length - 1, found >= 0 ? found : restoreIndex));
    this.link = found >= 0 || this.restoreKey === null ? Math.min(restoreLink, (this.stops[this.focus]?.links.length ?? 0) - 1) : -1;
    this.restoreKey = null;
    this.scroll = this.clampScroll(this.scroll);
    const focused = this.focusedSpan();
    if (focused) this.scroll = this.scrollToShow(focused);
  }

  private layoutBlock(block: StudyBlock, fonts: StudyFonts, width: number, top: number, links: Map<string, LinkStop>): number {
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
          this.place(line, run, font, value, x, dy, text.slice(0, cut), links);
          text = text.slice(cut);
          tokenWidth = font.measureText(text);
          newLine();
        }
        this.place(line, run, font, value, x, dy, text, links);
        x += tokenWidth;
        lineStart = false;
      }
    }
    if (line.fragments.length > 0 || !lineStart || block.runs.length === 0) this.lines.push(line);
    else return line.top - LINE_GAP;
    return line.bottom;
  }

  private place(line: Line, run: StudyRun, font: UiFont, value: number, x: number, dy: number, text: string, links: Map<string, LinkStop>): void {
    const y = line.top + dy;
    const previous = line.fragments[line.fragments.length - 1];
    const underline = run.action !== undefined;
    // Words of one run on one line draw as one fragment (spaces included).
    if (previous && previous.run === run && previous.y === y) {
      const gap = x - (previous.x + font.measureText(previous.text));
      const spaces = Math.max(0, Math.round(gap / Math.max(1, font.measureText(" "))));
      previous.text += " ".repeat(spaces) + text;
    } else {
      line.fragments.push({ x, y, text, font, value, underline, run });
    }
    if (run.action) {
      let stop = links.get(run.action.key);
      if (!stop) {
        stop = { action: run.action, top: line.top, bottom: line.bottom, rects: [] };
        links.set(run.action.key, stop);
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

  /** Swipe down: the next block (or link, stepped in), if it is no more than a page away; else a page further. */
  moveDown(): void {
    this.move(1);
  }

  /** Swipe up: the previous block (or link), if it is no more than a page away; else a page back. */
  moveUp(): void {
    this.move(-1);
  }

  private move(direction: 1 | -1): void {
    const inside = this.link >= 0;
    const targets: Span[] = inside ? this.stops[this.focus]!.links : this.stops;
    const current = inside ? this.link : this.focus;
    const page = this.pageStep();
    const next = targets[current + direction];
    const here = targets[current];
    // A block taller than the screen scrolls through before the focus leaves it.
    const pending = here && !inside && (direction > 0
      ? here.bottom > this.scroll + this.viewHeight
      : here.top < this.scroll);
    if (next && !pending) {
      const target = this.scrollToShow(next);
      if (Math.abs(target - this.scroll) <= page) {
        if (inside) this.link = current + direction;
        else this.focus = current + direction;
        this.scroll = target;
        return;
      }
    }
    if (!next && !pending) return;
    this.scroll = this.clampScroll(direction > 0 ? this.snapDown(this.scroll + page) : this.snapUp(this.scroll - page));
  }

  /** Tap: run the block's action, follow its only link, step into its links, or follow the focused link. */
  activate(ctx: LayerContext): boolean {
    const stop = this.stops[this.focus];
    if (!stop) return false;
    if (this.link >= 0) {
      stop.links[this.link]?.action.run(ctx);
      return true;
    }
    if (stop.action) {
      stop.action.run(ctx);
      return true;
    }
    if (stop.links.length === 1) {
      stop.links[0]!.action.run(ctx);
      return true;
    }
    if (stop.links.length > 1) {
      // Step in at the first link on screen.
      const visible = stop.links.findIndex((link) => link.top >= this.scroll && link.bottom <= this.scroll + this.viewHeight);
      this.link = Math.max(0, visible);
      this.scroll = this.scrollToShow(stop.links[this.link]!);
      return true;
    }
    return false;
  }

  hasFocus(): boolean {
    return this.stops.length > 0;
  }

  /** Draw the visible lines into (x, y, width, viewHeight); lines cut by the edges are left out. */
  paint(image: GrayImage, x: number, y: number, width: number): void {
    const top = this.scroll;
    const bottom = top + this.viewHeight;
    const block = this.stops[this.focus];
    if (block) {
      const boxTop = Math.max(block.top, top - 2) - 3;
      const boxBottom = Math.min(block.bottom, bottom + 2) + 3;
      image.drawRoundedRect(x - 6, y + boxTop - top, width + 12, boxBottom - boxTop, this.link >= 0 ? 70 : 170, 6);
      const link = this.link >= 0 ? block.links[this.link] : undefined;
      for (const rect of link?.rects ?? []) {
        if (rect.y < top || rect.y + rect.height > bottom) continue;
        image.fillRoundedRect(x + rect.x - 3, y + rect.y - top - 1, rect.width + 6, rect.height + 2, 30, 4);
        image.drawRoundedRect(x + rect.x - 3, y + rect.y - top - 1, rect.width + 6, rect.height + 2, 170, 4);
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

  private focusedSpan(): Span | undefined {
    const block = this.stops[this.focus];
    return this.link >= 0 ? block?.links[this.link] : block;
  }

  private pageStep(): number {
    // Keep a line or two of what was on screen.
    return Math.max(20, this.viewHeight - 40);
  }

  /** The scroll that shows a span whole (its top, if it is taller than the view). */
  private scrollToShow(span: Span): number {
    let target = this.scroll;
    if (span.bottom > target + this.viewHeight) target = span.bottom - this.viewHeight;
    if (span.top < target) target = span.top;
    return this.clampScroll(this.snapForTop(target, span.top));
  }

  /** Snap to a line top so no line is cut, but never past the span's own top. */
  private snapForTop(target: number, spanTop: number): number {
    const snapped = this.snapUp(target);
    return snapped > spanTop ? this.snapDown(spanTop) : snapped;
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
    const limit = this.snapUp(max) >= max ? this.snapUp(max) : max;
    return Math.max(0, Math.min(limit, scroll));
  }
}

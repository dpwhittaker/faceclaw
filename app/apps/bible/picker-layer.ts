import { GrayImage, type UiFont } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { getDefaultLargeFont, getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import {
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_SCROLL_DOWN,
  GESTURE_SCROLL_UP,
  type InputEvent,
} from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { drawSelectionHighlight } from "../../ui/menu";
import { RingSwipeFilter } from "../../ui/ring-swipe-filter";
import { shrinkingFonts } from "./bible-fonts";
import { bookByNumber, formatChapter, type VerseRef } from "./books";
import { type PassagePicker, type PickerOutcome } from "./passage-picker";
import {
  nodeDepth,
  type PickNode,
  rangeLabel,
  SLOT_BOTTOM,
  SLOT_MIDDLE,
  SLOT_TOP,
} from "./trinary-tree";

const MARGIN = 6;
/** Column left of the boxes holding each box's gesture glyph. */
const GUTTER = 16;
const BOX_GAP = 6;
const BOX_PAD = 6;
const BOX_RADIUS = 8;
/** Horizontal space between items of one run of three, and between runs. */
const ITEM_GAP = 7;
const TRIPLET_GAP = 14;
const BOX_GESTURES = [GESTURE_SCROLL_UP, GESTURE_CLICK, GESTURE_SCROLL_DOWN] as const;

const LEAF_VALUE = 240;
const RANGE_VALUE = 185;
const DIVIDER_VALUE = 45;

export type PassagePickerLayerOptions = {
  picker: PassagePicker;
  /** A verse was chosen. */
  onPicked: (ref: VerseRef, ctx: LayerContext) => void;
  /** Double-tap at the outermost level of choosing a book. */
  onExit: (ctx: LayerContext) => void;
};

/** One item placed in a row: its label, left edge and width. */
type PlacedItem = { node: PickNode<number>; text: string; x: number; width: number };
type PlacedRow = { items: PlacedItem[]; dividers: number[] };

/** How every box of one level on screen draws: one font for all, and where each item goes. */
type GridPlan = { font: UiFont; rows: Map<number, PlacedRow[]> };

/**
 * The passage picker, full screen (see PassagePicker). Three boxes stack down
 * the window, entered by swipe up, tap and swipe down, with the gesture drawn
 * left of each. A box shows as much of what lies inside it as fits: up to 27
 * items as three rows of nine (each row is one box of the next level, each
 * run of three one of its rows), nine as three rows of three, three across,
 * one large. Book names are spelled out, shrinking the font for the long rows
 * of the New Testament; abbreviations are the last resort.
 */
export class PassagePickerLayer implements Layer {
  private readonly swipeFilter = new RingSwipeFilter();

  constructor(private readonly options: PassagePickerLayerOptions) {}

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (!this.swipeFilter.accept(event)) return;
    const picker = this.options.picker;
    switch (event.type) {
      case "scroll-up":
        this.apply(picker.enter(SLOT_TOP), ctx);
        return;
      case "click":
        this.apply(picker.enter(SLOT_MIDDLE), ctx);
        return;
      case "scroll-down":
        this.apply(picker.enter(SLOT_BOTTOM), ctx);
        return;
      case "double-click":
        this.apply(picker.back(), ctx);
        return;
      default:
        return;
    }
  }

  private apply(outcome: PickerOutcome, ctx: LayerContext): void {
    if (outcome.kind === "picked") this.options.onPicked(outcome.ref, ctx);
    else if (outcome.kind === "exit") this.options.onExit(ctx);
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    this.paintHeader(image, small, width);

    const top = MARGIN + small.lineHeight + 4;
    const boxX = MARGIN + GUTTER;
    const boxWidth = width - boxX - MARGIN;
    const boxHeight = Math.floor((height - top - MARGIN - 2 * BOX_GAP) / 3);
    const slots = this.options.picker.getCursor().slots();
    const plans = planGrids(slots, boxWidth - 2 * BOX_PAD, boxHeight - 2 * BOX_PAD);

    for (let slot = SLOT_TOP; slot <= SLOT_BOTTOM; slot++) {
      const node = slots[slot] ?? null;
      const y = top + slot * (boxHeight + BOX_GAP);
      if (!node) {
        image.drawRoundedRect(boxX, y, boxWidth, boxHeight, 35, BOX_RADIUS);
        continue;
      }
      if (slot === SLOT_MIDDLE) drawSelectionHighlight(image, boxX, y, boxWidth, boxHeight, true, BOX_RADIUS);
      else image.drawRoundedRect(boxX, y, boxWidth, boxHeight, 110, BOX_RADIUS);
      const glyph = BOX_GESTURES[slot]!;
      image.drawText(small, Math.round(MARGIN + (GUTTER - small.measureText(glyph)) / 2) - 2,
        y + ((boxHeight - small.lineHeight) >> 1), glyph, 120);
      paintBox(image, node, slot, plans, boxX + BOX_PAD, y + BOX_PAD, boxWidth - 2 * BOX_PAD, boxHeight - 2 * BOX_PAD);
    }
    return image;
  }

  private paintHeader(image: GrayImage, font: UiFont, width: number): void {
    const picker = this.options.picker;
    const phase = picker.getPhase();
    const cursor = picker.getCursor();
    const title = phase.kind === "book" ? "Choose a book"
      : phase.kind === "chapter" ? `${bookByNumber(phase.book)?.name ?? ""} · chapter`
      : `${formatChapter(phase.book, phase.chapter)} · verse`;
    const where = cursor.isAtRoot() ? "" : rangeLabel(cursor.current());
    const back = `${GESTURE_DOUBLE_CLICK} back`;
    const right = where ? `${where}    ${back}` : back;
    const rightWidth = font.measureText(right);
    image.drawText(font, MARGIN, MARGIN, truncateText(font, title, width - 3 * MARGIN - rightWidth), 230);
    image.drawText(font, Math.round(width - MARGIN - rightWidth), MARGIN, right, 130);
  }
}

/** How many levels below a box it draws: up to three (27 items as rows of nine). */
function boxLevel(node: PickNode<number>): number {
  return Math.min(3, nodeDepth(node));
}

/**
 * The 3^level positions `level` steps below a node, left to right. A leaf met
 * early sits in the middle of the positions it would fill, like a lone key in
 * the ring keyboard's rows.
 */
function expand(node: PickNode<number> | null, level: number): Array<PickNode<number> | null> {
  if (level === 0) return [node];
  if (!node) return new Array<PickNode<number> | null>(3 ** level).fill(null);
  const children = node.kind === "group" ? node.children : [null, node, null];
  return children.flatMap((child) => expand(child, level - 1));
}

/** A box's rows of cells: three rows of nine or of three, or one row of three. */
function boxRows(node: PickNode<number>): Array<Array<PickNode<number> | null>> {
  const level = boxLevel(node);
  if (level <= 1) return [expand(node, 1)];
  const children = node.kind === "group" ? node.children : [null, node, null];
  return children.map((child) => expand(child, level - 1));
}

function shortLabel(node: PickNode<number>): string | undefined {
  return node.kind === "leaf" ? (node as { short?: string }).short : undefined;
}

function cellLabel(node: PickNode<number>, abbreviate = false): string {
  if (node.kind === "group") return rangeLabel(node);
  const short = shortLabel(node);
  return abbreviate && short ? short : node.label;
}

/** The even grid: each cell its own column, so numbers line up from row to row. Null if a label overflows. */
function placeRowEvenly(cells: Array<PickNode<number> | null>, font: UiFont, width: number): PlacedRow | null {
  const cellWidth = width / cells.length;
  const items: PlacedItem[] = [];
  for (let index = 0; index < cells.length; index++) {
    const node = cells[index];
    if (!node) continue;
    const text = cellLabel(node);
    const textWidth = font.measureText(text);
    if (textWidth > cellWidth - 4) return null;
    items.push({ node, text, width: textWidth, x: (index + 0.5) * cellWidth - textWidth / 2 });
  }
  return { items, dividers: cells.length === 9 ? [width / 3, (2 * width) / 3] : [] };
}

/**
 * Packed by width, the leftover shared among the gaps (runs of three keep
 * wider gaps, with a divider in each). Null when the labels don't fit.
 */
function placeRowPacked(
  cells: Array<PickNode<number> | null>,
  font: UiFont,
  width: number,
  abbreviated: ReadonlySet<PickNode<number>>,
): PlacedRow | null {
  const runLength = cells.length === 9 ? 3 : 1;
  const present: Array<{ node: PickNode<number>; index: number; text: string; width: number }> = [];
  cells.forEach((node, index) => {
    if (!node) return;
    const text = cellLabel(node, abbreviated.has(node));
    present.push({ node, index, text, width: font.measureText(text) });
  });
  const gaps: number[] = [];
  for (let i = 1; i < present.length; i++) {
    const sameRun = Math.floor(present[i]!.index / runLength) === Math.floor(present[i - 1]!.index / runLength);
    gaps.push(sameRun ? ITEM_GAP : TRIPLET_GAP);
  }
  const needed = present.reduce((sum, item) => sum + item.width, 0) + gaps.reduce((sum, gap) => sum + gap, 0);
  if (needed > width) return null;
  // The leftover goes to the gaps and the two ends, the runs' gaps twice over.
  const shares = gaps.reduce((sum, gap) => sum + (gap === TRIPLET_GAP ? 2 : 1), 0) + 2;
  const unit = (width - needed) / shares;
  let x = unit;
  const items: PlacedItem[] = [];
  const dividers: number[] = [];
  present.forEach((item, i) => {
    if (i > 0) {
      const gap = gaps[i - 1]!;
      const grown = gap + unit * (gap === TRIPLET_GAP ? 2 : 1);
      if (gap === TRIPLET_GAP && runLength === 3) dividers.push(x + grown / 2);
      x += grown;
    }
    items.push({ node: item.node, text: item.text, x, width: item.width });
    x += item.width;
  });
  return { items, dividers };
}

/**
 * Pack a row, abbreviating its widest names one at a time until it fits.
 * Null when it doesn't fit even fully abbreviated.
 */
function fitRowPacked(
  cells: Array<PickNode<number> | null>,
  font: UiFont,
  width: number,
): { row: PlacedRow; abbreviations: number } | null {
  const abbreviated = new Set<PickNode<number>>();
  for (;;) {
    const row = placeRowPacked(cells, font, width, abbreviated);
    if (row) return { row, abbreviations: abbreviated.size };
    let widest: PickNode<number> | null = null;
    let widestWidth = -1;
    for (const node of cells) {
      if (!node || abbreviated.has(node) || !shortLabel(node)) continue;
      const nodeWidth = font.measureText(node.label);
      if (nodeWidth > widestWidth) {
        widest = node;
        widestWidth = nodeWidth;
      }
    }
    if (!widest) return null;
    abbreviated.add(widest);
  }
}

/** A box's rows on the even grid if every row fits it, else all packed. */
function fitBox(
  node: PickNode<number>,
  font: UiFont,
  width: number,
): { rows: PlacedRow[]; abbreviations: number } | null {
  const cells = boxRows(node);
  const even = cells.map((row) => placeRowEvenly(row, font, width));
  if (even.every((row) => row !== null)) return { rows: even as PlacedRow[], abbreviations: 0 };
  const rows: PlacedRow[] = [];
  let abbreviations = 0;
  for (const row of cells) {
    const result = fitRowPacked(row, font, width);
    if (!result) return null;
    rows.push(result.row);
    abbreviations += result.abbreviations;
  }
  return { rows, abbreviations };
}

/**
 * Choose one font for every grid box of the same level on screen, so the
 * boxes read alike: the one that spells out the most names (abbreviating only
 * where a row can't fit otherwise), the largest among equals.
 */
function planGrids(
  slots: readonly (PickNode<number> | null)[],
  innerWidth: number,
  innerHeight: number,
): Map<number, GridPlan> {
  const plans = new Map<number, GridPlan>();
  for (const level of [1, 2, 3]) {
    const boxes = slots
      .map((node, slot) => ({ node, slot }))
      .filter((box): box is { node: PickNode<number>; slot: number } => box.node !== null && boxLevel(box.node) === level);
    if (boxes.length === 0) continue;
    const rowsPerBox = level === 1 ? 1 : 3;
    const ladder = (level === 1 ? [getDefaultMediumFont(), ...shrinkingFonts()] : shrinkingFonts())
      .filter((font, index) => index === 0 || font.lineHeight <= innerHeight / rowsPerBox);
    let best: { plan: GridPlan; abbreviations: number } | null = null;
    for (const font of ladder) {
      const rows = new Map<number, PlacedRow[]>();
      let abbreviations = 0;
      let fits = true;
      for (const box of boxes) {
        const result = fitBox(box.node, font, innerWidth);
        if (!result) {
          fits = false;
          break;
        }
        rows.set(box.slot, result.rows);
        abbreviations += result.abbreviations;
      }
      if (fits && (!best || abbreviations < best.abbreviations)) best = { plan: { font, rows }, abbreviations };
      if (best?.abbreviations === 0) break;
    }
    if (best) plans.set(level, best.plan);
  }
  return plans;
}

function paintBox(
  image: GrayImage,
  node: PickNode<number>,
  slot: number,
  plans: Map<number, GridPlan>,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const level = boxLevel(node);
  const plan = level > 0 ? plans.get(level) : undefined;
  const rows = plan?.rows.get(slot);
  if (!plan || !rows) {
    // One item (or a grid that fit nothing): its label, large.
    const font = getDefaultLargeFont();
    const text = truncateText(font, cellLabel(node), width);
    image.drawText(font, Math.round(x + (width - font.measureText(text)) / 2), y + ((height - font.lineHeight) >> 1), text, LEAF_VALUE);
    return;
  }
  const font = plan.font;
  const rowHeight = height / rows.length;
  rows.forEach((row, rowIndex) => {
    const rowTop = y + rowIndex * rowHeight;
    if (rowIndex > 0 && rows.length === 3) {
      image.fillRect(x + 4, Math.round(rowTop), width - 8, 1, DIVIDER_VALUE);
    }
    const textTop = Math.round(rowTop + (rowHeight - font.lineHeight) / 2);
    for (const divider of row.dividers) {
      image.fillRect(Math.round(x + divider), Math.round(rowTop + 4), 1, Math.max(1, Math.round(rowHeight - 8)), DIVIDER_VALUE);
    }
    for (const item of row.items) {
      const value = item.node.kind === "leaf" ? LEAF_VALUE : RANGE_VALUE;
      image.drawText(font, Math.round(x + item.x), textTop, item.text, value);
    }
  });
}

/**
 * The ring keyboard's character tree and the cursor that walks it. Every
 * group splits its keys into three parts — top, middle, bottom — which the
 * Text input dialog draws as three stacked boxes: swipe up zooms into the top
 * box, swipe down into the bottom one, tap into the middle one, and a box
 * that holds a single key types it. Double-tap zooms back out.
 *
 * The keyboard opens, and returns after every character but a digit, at the
 * letters group: 26 letters and space in nine rows of three, every one three
 * moves away. The middle of each row, typed with a tap, is one of the nine
 * most common characters (space and the eight most common English letters).
 * One zoom out from the letters is the root, with numbers and punctuation
 * above the letters and everything else (a deeper tree: accents, symbols,
 * arrows, box drawing, Greek, Cyrillic, kana) below. A digit returns to
 * numbers and punctuation instead, since most numbers run to more than one
 * digit.
 *
 * Keys carry a shifted character, as on a US keyboard: capitals for letters,
 * the symbol above each digit and punctuation key (1!, ,<, \|), so all of
 * ASCII fits in two boxes of 27.
 *
 * Kept free of NativeScript imports so tests can load it under plain node.
 */

export type KeyLeaf = {
  readonly kind: "key";
  /** What typing the key inserts. */
  readonly text: string;
  /** What it inserts with shift, when that isn't its capital (QWERTY symbol pairs). */
  readonly shifted?: string;
  /** What the key shows when that isn't its text (Enter, Tab); space is drawn specially. */
  readonly label?: string;
};

/** Three slots, top to bottom; null leaves that box empty. */
export type KeySlots = readonly [KeyNode | null, KeyNode | null, KeyNode | null];

export type KeyGroup = {
  readonly kind: "group";
  /** Name in the dialog's breadcrumb, and the caption of a box too deep to draw whole. */
  readonly label?: string;
  /** Sample characters drawn in such a box. */
  readonly preview?: string;
  readonly children: KeySlots;
};

export type KeyNode = KeyLeaf | KeyGroup;

/** Slot indexes, in gesture terms. */
export const SLOT_TOP = 0;
export const SLOT_MIDDLE = 1;
export const SLOT_BOTTOM = 2;
export type Slot = typeof SLOT_TOP | typeof SLOT_MIDDLE | typeof SLOT_BOTTOM;

export function key(text: string, label?: string, shifted?: string): KeyLeaf {
  return {
    kind: "key",
    text,
    ...(shifted !== undefined ? { shifted } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

export const SPACE = key(" ");
export const ENTER = key("\n", "↵");
export const TAB = key("\t", "↦");

function chars(text: string): string[] {
  return Array.from(text);
}

/**
 * A group from up to three nodes; a group of one collapses to that node so
 * the dialog never shows a box that only zooms into the same thing again.
 */
function slots(nodes: ReadonlyArray<KeyNode | null>): KeyNode {
  const present = nodes.filter((node): node is KeyNode => node !== null);
  return present.length === 1 ? present[0]! : group(nodes);
}

const SPECIAL_KEYS: Readonly<Record<string, KeyLeaf>> = { " ": SPACE, "\n": ENTER, "\t": TAB };

/** One row of the keyboard: up to three characters, left to right = top to bottom. */
function row(text: string): KeyNode {
  return slots(chars(text).map((char) => SPECIAL_KEYS[char] ?? key(char)));
}

/** A row of QWERTY pairs, e.g. pairs("1! 2@ 3#"): each key's character, then its shifted one. */
function pairs(spec: string): KeyNode {
  return slots(spec.split(" ").map((pair) => {
    const [text, shifted] = chars(pair);
    return key(text!, undefined, shifted);
  }));
}

/** A group of three rows, e.g. rows("bac", "def", "ghj"). */
function rows(top: string, middle: string, bottom: string, label?: string, preview?: string): KeyGroup {
  return group([row(top), row(middle), row(bottom)], label, preview);
}

function group(children: ReadonlyArray<KeyNode | null>, label?: string, preview?: string): KeyGroup {
  return {
    kind: "group",
    ...(label !== undefined ? { label } : {}),
    ...(preview !== undefined ? { preview } : {}),
    children: [children[0] ?? null, children[1] ?? null, children[2] ?? null],
  };
}

/**
 * A tree over a flat run of characters for the deeper menus: rows of three,
 * groups of nine, 27, 81, filled in order, so each box shows whole rows.
 */
function spread(text: string, label: string, preview?: string): KeyGroup {
  const build = (items: KeyNode[]): KeyNode => {
    if (items.length === 1) return items[0]!;
    let chunk = 1;
    while (chunk * 3 < items.length) chunk *= 3;
    const parts = [items.slice(0, chunk), items.slice(chunk, 2 * chunk), items.slice(2 * chunk)];
    return slots(parts.map((part) => (part.length ? build(part) : null)));
  };
  const built = build(chars(text).map((char) => key(char)));
  const children = built.kind === "group" ? built.children : [null, built, null];
  return group(children, label, preview ?? chars(text).slice(0, 3).join(""));
}

/**
 * The letters: in each row the middle character is one of space, e, t, a, o,
 * i, n, s, h — in alphabetical order down the middle column, space last —
 * and the other eighteen letters run alphabetically down the outer columns.
 */
export const LETTERS: KeyGroup = group([
  rows("bac", "def", "ghj"),
  rows("kil", "mnp", "qor"),
  rows("usv", "wtx", "y z"),
], "Letters", "abc");

/**
 * Digits and punctuation on QWERTY keys, so every one is three moves from
 * here: 1-9 as a phone keypad, the common punctuation in the middle box (the
 * period a tap, tap, tap), and the rest with Enter and Tab below.
 */
const NUMBERS_AND_PUNCTUATION: KeyGroup = group([
  group([pairs("1! 2@ 3#"), pairs("4$ 5% 6^"), pairs("7& 8* 9(")], "Digits"),
  group([pairs(";: ,< '\""), pairs("/? .> -_"), pairs("[{ 0) ]}")], "Punctuation"),
  group([pairs("`~ \\| =+"), ENTER, TAB], "Symbols & keys"),
], "Numbers & punctuation", "1! .,?");

const ACCENTED = spread(
  "àáâäãåæçèéêëìíîïñòóôöõøùúûü" +
  "ýÿßœāēīōūąęćčďěłńňřśšťůźżžğ" +
  "şţıðþőűĺľŕĉĝĥĵŝŭŵŷģķļņŗėįųŀ",
  "Accented letters", "éñü");
const TYPOGRAPHY = spread("–—…•·«»“”‘’„¡¿§¶†©®™°€£¥¢₹₽", "Typography & currency", "—“€");
const MATH = spread("±×÷≠≈≡≤∞≥½¼¾¹²³√′″π∑∆µ∫∂∈∀∃", "Math", "±≠½");

const ARROWS = group([
  rows("↖↑↗", "←↔→", "↙↓↘"),
  rows("⇖⇑⇗", "⇐⇔⇒", "⇙⇓⇘"),
  rows("↵↩↪", "↺↕↻", "⇤⇕⇥"),
], "Arrows", "←↑→");
const BOX_DRAWING = group([
  rows("┌┬┐", "├┼┤", "└┴┘"),
  rows("╔╦╗", "╠╬╣", "╚╩╝"),
  rows("─═▄", "│║█", "░▒▓"),
], "Box drawing", "┌┼▒");
const SHAPES = group([
  rows("●○◆", "■□◇", "▲▼▶"),
  rows("★☆♥", "♠♣♦", "♪♫✓"),
  rows("☀☁☂", "☺☹✗", "◀△▽"),
], "Shapes & icons", "●★♥");

const GREEK = spread("αβγδεζηθικλμνξοπρστυφχψως", "Greek", "αβγ");
const CYRILLIC = spread("абвгдеёжзийклмнопрстуфхцчшщъыьэюя", "Cyrillic", "абв");
const HIRAGANA = spread(
  "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん" +
  "がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽぁぃぅぇぉっゃゅょ",
  "Hiragana", "あいう");
const KATAKANA = spread(
  "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン" +
  "ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポァィゥェォッャュョー",
  "Katakana", "アイウ");
const KANA = group([HIRAGANA, KATAKANA, spread("、。・「」『』〜〃", "Japanese punctuation", "、。「")], "Kana", "あア");

const MORE: KeyGroup = group([
  group([ACCENTED, TYPOGRAPHY, MATH], "Latin & symbols", "é€±"),
  group([ARROWS, BOX_DRAWING, SHAPES], "Arrows & drawing", "→┼●"),
  group([GREEK, CYRILLIC, KANA], "Scripts", "αжあ"),
], "More", "é→★あ");

export const KEYBOARD_ROOT: KeyGroup = group([NUMBERS_AND_PUNCTUATION, LETTERS, MORE]);

/** How many levels a node spans: 0 for a key, 1 for a row of keys, ... */
export function nodeDepth(node: KeyNode): number {
  if (node.kind === "key") return 0;
  let depth = 0;
  for (const child of node.children) {
    if (child) depth = Math.max(depth, nodeDepth(child));
  }
  return depth + 1;
}

/** The first `count` keys under a node, depth first. */
export function firstKeys(node: KeyNode, count: number): KeyLeaf[] {
  const out: KeyLeaf[] = [];
  const visit = (current: KeyNode): void => {
    if (out.length >= count) return;
    if (current.kind === "key") {
      out.push(current);
      return;
    }
    for (const child of current.children) {
      if (child) visit(child);
    }
  };
  visit(node);
  return out;
}

/**
 * What a key types with shift: its pair, or its capital where that is one
 * character; keys with neither (space, symbols, kana) type themselves.
 */
export function shiftedText(leaf: KeyLeaf): string {
  if (leaf.shifted !== undefined) return leaf.shifted;
  const upper = leaf.text.toUpperCase();
  return chars(upper).length === 1 ? upper : leaf.text;
}

/**
 * Where the cursor goes after typing `text`: the numbers and punctuation
 * for a digit (the next key is likely another digit, or a decimal point),
 * the letters for anything else.
 */
export function groupAfter(text: string): KeyGroup {
  return /^[0-9]$/.test(text) ? NUMBERS_AND_PUNCTUATION : LETTERS;
}

/** What a gesture did: zoomed, typed `text`, or nothing (an empty box). */
export type KeyboardOutcome =
  | { kind: "moved" }
  | { kind: "typed"; text: string }
  | { kind: "none" };

/**
 * Where the wearer is in the tree. The path runs from the root to the
 * current group; it never empties (the root is always on it). Keys are typed
 * on the way in, never stood on.
 */
export class TrinaryKeyboard {
  private path: KeyGroup[] = [];

  constructor() {
    this.reset();
  }

  /** Back to one of the root's groups: by default the letters, where the keyboard opens. */
  reset(group: KeyGroup = LETTERS): void {
    this.path = [KEYBOARD_ROOT, group];
  }

  current(): KeyGroup {
    return this.path[this.path.length - 1]!;
  }

  isAtRoot(): boolean {
    return this.path.length === 1;
  }

  isAtHome(): boolean {
    return this.current() === LETTERS;
  }

  /** The labelled groups from the root down to here (the breadcrumb). */
  trail(): string[] {
    const labels: string[] = [];
    for (const node of this.path) {
      if (node.label) labels.push(node.label);
    }
    return labels;
  }

  /** Swipe up / swipe down: zoom into the top or bottom box, or type it when it is one key. */
  zoom(slot: typeof SLOT_TOP | typeof SLOT_BOTTOM, shifted = false): KeyboardOutcome {
    return this.enter(this.current().children[slot] ?? null, shifted);
  }

  /** Tap: the same for the middle box. */
  tap(shifted = false): KeyboardOutcome {
    return this.enter(this.current().children[SLOT_MIDDLE] ?? null, shifted);
  }

  private enter(child: KeyNode | null, shifted: boolean): KeyboardOutcome {
    if (!child) return { kind: "none" };
    if (child.kind === "group") {
      this.path.push(child);
      return { kind: "moved" };
    }
    const text = shifted ? shiftedText(child) : child.text;
    this.reset(groupAfter(text));
    return { kind: "typed", text };
  }

  /** Double-tap: zoom out one level. False at the root, where there is nowhere further out. */
  back(): boolean {
    if (this.path.length <= 1) return false;
    this.path.pop();
    return true;
  }
}

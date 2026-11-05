import { type Bitmap, createBitmap, drawSprite, fillRect } from './bitmap';
import { FONT_5X8, drawText, textWidth, type BitmapFont } from './font5x8';
import { FONT_7X10 } from './font-clr7x10';
import { FONT_8X12 } from './font-clr8x12';
import type { Measure, NoteEvent, Score } from './musicxml-types';

/**
 * Pixel engraver for the G2. A score becomes a 576px-wide strip of bands, one
 * system per band, 4 or 6 bands to the 288px screen (72px or 48px each). A
 * band holds a staff (1px lines; 4, 6 or 8px pitch for small, medium or large
 * notes), room for two ledger lines below it, and a lyric row at the bottom
 * in a 5x8, 7x10 or 8x12 font. The strip is sliced into 288x144 clips, left
 * and right, two or three systems each. Every combination is allowed; the
 * big ones overlap (a low note's ledger lines run into the lyrics).
 *
 * The default (6 staves, medium notes, small font) is a 25px staff with 2px
 * above it and an 8px lyric row at the bottom of a 48px band.
 *
 * Spacing is proportional: a medium quarter is 20px, a half 40, a whole 80,
 * nothing under 15, and a syllable widens its note's slot so it never runs
 * under the next note. Lines break at measure boundaries when the next
 * measure would not fit.
 */

export const LINE_W = 576;
export const SCREEN_H = 288;
export const CLIP_W = 288;
export const CLIP_H = 144;

// ── Options and geometry ───────────────────────────────────────────────────

export type Staves = 4 | 6;
export type Size = 'small' | 'medium' | 'large';
export type EngraveOptions = { staves: Staves; notes: Size; font: Size };
export const DEFAULT_OPTIONS: EngraveOptions = { staves: 6, notes: 'medium', font: 'small' };

/** A sprite plus the row of it that sits on its reference row (a note centre, or the staff top for rests). */
type Glyph = { rows: readonly string[]; anchor: number };

/** Everything about the notation that depends on the note size. */
export type NoteGlyphs = {
  /** Staff line pitch; a notehead is `pitch - 1` rows tall and fills a space. */
  pitch: number;
  headFilled: readonly string[];
  headHollow: readonly string[];
  headWhole: readonly string[];
  stemLen: number;
  flag: readonly string[];
  sharp: Glyph;
  flat: Glyph;
  natural: Glyph;
  /** Room reserved before a notehead that carries an accidental. */
  accidentalW: number;
  /** Advance per key-signature accidental. */
  keyAdvance: number;
  restQuarter: Glyph;
  restEighth: Glyph;
  fermata: readonly string[];
  /** Augmentation dots are squares this size. */
  dot: number;
  /** Treble clef; `anchor` is its top row relative to the staff top (negative = above). */
  clef: Glyph;
  quarterPx: number;
  minSlotPx: number;
  /** How far a ledger line sticks out past the notehead on each side. */
  ledgerOverhang: number;
};

/**
 * Nearest-neighbour rescale of a `.`/`X` sprite. Shrinking maps each lit pixel
 * forward (rounded), which keeps a 1px stroke connected; enlarging samples
 * each output pixel back, which only ever duplicates rows and columns.
 */
export function scaleSprite(rows: readonly string[], f: number): string[] {
  const h = rows.length;
  const w = rows[0].length;
  if (f < 1) {
    const oh = Math.round((h - 1) * f) + 1;
    const ow = Math.round((w - 1) * f) + 1;
    const out = Array.from({ length: oh }, () => new Array<string>(ow).fill('.'));
    rows.forEach((row, y) => {
      for (let x = 0; x < w; x++) if (row[x] === 'X') out[Math.round(y * f)][Math.round(x * f)] = 'X';
    });
    return out.map((r) => r.join(''));
  }
  const oh = Math.round(h * f);
  const ow = Math.round(w * f);
  return Array.from({ length: oh }, (_, y) =>
    Array.from({ length: ow }, (_, x) => rows[Math.floor(y / f)][Math.floor(x / f)]).join(''),
  );
}

const scaleGlyph = (g: Glyph, f: number): Glyph => ({ rows: scaleSprite(g.rows, f), anchor: Math.round(g.anchor * f) });

// ── Medium sprites (the original 6px-pitch set) ────────────────────────────

export const HEAD_FILLED = ['..XXXX.', '.XXXXXX', 'XXXXXXX', 'XXXXXX.', '.XXXX..'];
export const HEAD_HOLLOW = ['..XXXX.', '.X...XX', 'X.....X', 'XX...X.', '.XXXX..'];
export const HEAD_WHOLE = ['.XXXXXX.', 'XX....XX', 'X......X', 'XX....XX', '.XXXXXX.'];
const FLAG_UP = ['X...', 'XX..', '.XX.', '..XX', '...X', '...X', '..X.'];
const SHARP = ['.X.X.', '.X.X.', 'XXXXX', '.X.X.', '.X.X.', 'XXXXX', '.X.X.', '.X.X.'];
const FLAT = ['X....', 'X....', 'X....', 'X.XX.', 'XX..X', 'X...X', 'X..X.', 'XXX..'];
const NATURAL = ['X....', 'X....', 'XXXX.', 'X..X.', 'X..X.', '.XXXX', '...X.', '...X.'];
const REST_QUARTER = ['.X...', '..X..', '...X.', '..X..', '.X...', '..X..', '...X.', '..XX.', '.X...', 'X....', '.XX..', '..X..', '.X...'];
const REST_EIGHTH = ['.X..X', '.XXX.', '...X.', '...X.', '..X..', '..X..', '.X...'];
const FERMATA = ['..XXX..', '.X...X.', 'X.....X', '...X...'];
/** 9 wide, 34 tall; drawn from 2 rows above the staff so the curl circles the G line. */
const CLEF = [
  '.....XX..',
  '....X..X.',
  '....X..X.',
  '....X..X.',
  '....X..X.',
  '....X.X..',
  '....X.X..',
  '....XX...',
  '...X.X...',
  '...X.X...',
  '..X..X...',
  '..X..X...',
  '.X...X...',
  '.X...X...',
  'X....X...',
  'X....X...',
  'X....XXX.',
  'X....X..X',
  'X...XX..X',
  'X..X.X..X',
  '.X.X.X..X',
  '.XX..X.X.',
  '.....XX..',
  '....X.X..',
  '....X....',
  '....X....',
  '....X....',
  '....X....',
  '....X....',
  '....X....',
  '..X.X....',
  '.X..X....',
  '.X.X.....',
  '..XX.....',
];

const MEDIUM: NoteGlyphs = {
  pitch: 6,
  headFilled: HEAD_FILLED,
  headHollow: HEAD_HOLLOW,
  headWhole: HEAD_WHOLE,
  stemLen: 14,
  flag: FLAG_UP,
  sharp: { rows: SHARP, anchor: 4 },
  flat: { rows: FLAT, anchor: 6 },
  natural: { rows: NATURAL, anchor: 4 },
  accidentalW: 6,
  keyAdvance: 6,
  restQuarter: { rows: REST_QUARTER, anchor: 4 },
  restEighth: { rows: REST_EIGHTH, anchor: 10 },
  fermata: FERMATA,
  dot: 2,
  clef: { rows: CLEF, anchor: -2 },
  quarterPx: 20,
  minSlotPx: 15,
  ledgerOverhang: 3,
};

/** 4px pitch, 5x3 heads. Clef and rests are the medium ones shrunk by 2/3. */
const SMALL: NoteGlyphs = {
  pitch: 4,
  headFilled: ['.XXXX', 'XXXXX', 'XXXX.'],
  headHollow: ['.XXXX', 'X...X', 'XXXX.'],
  headWhole: ['.XXXX.', 'XX..XX', '.XXXX.'],
  stemLen: 10,
  flag: ['X..', 'XX.', '.XX', '..X', '..X'],
  sharp: { rows: ['.X.X', 'XXXX', '.X.X', '.X.X', 'XXXX', '.X.X'], anchor: 3 },
  flat: { rows: ['X...', 'X...', 'X...', 'X.X.', 'XX.X', 'X..X', 'XXX.'], anchor: 5 },
  natural: { rows: ['X..', 'X..', 'XXX', 'X.X', 'XXX', '..X', '..X'], anchor: 3 },
  accidentalW: 5,
  keyAdvance: 5,
  restQuarter: scaleGlyph(MEDIUM.restQuarter, 2 / 3),
  restEighth: scaleGlyph(MEDIUM.restEighth, 2 / 3),
  fermata: ['.XXX.', 'X...X', '..X..'],
  dot: 2,
  clef: scaleGlyph(MEDIUM.clef, 2 / 3),
  quarterPx: 16,
  minSlotPx: 12,
  ledgerOverhang: 2,
};

/** 8px pitch, 9x7 heads. Clef, rests and fermata are the medium ones enlarged by 4/3. */
const LARGE: NoteGlyphs = {
  pitch: 8,
  headFilled: ['...XXXXX.', '.XXXXXXXX', 'XXXXXXXXX', 'XXXXXXXXX', 'XXXXXXXXX', 'XXXXXXXX.', '.XXXXX...'],
  headHollow: ['...XXXXX.', '.XX...XXX', 'XX.....XX', 'X.......X', 'XX.....XX', 'XXX...XX.', '.XXXXX...'],
  headWhole: ['..XXXXXX..', '.XXX..XXX.', 'XXX....XXX', 'XX......XX', 'XXX....XXX', '.XXX..XXX.', '..XXXXXX..'],
  stemLen: 19,
  flag: ['X....', 'XX...', '.XX..', '..XX.', '...XX', '....X', '....X', '...X.', '..X..'],
  sharp: {
    rows: ['.X..X.', '.X..X.', '.X..X.', 'XXXXXX', '.X..X.', '.X..X.', '.X..X.', 'XXXXXX', '.X..X.', '.X..X.', '.X..X.'],
    anchor: 5,
  },
  flat: {
    rows: ['X....', 'X....', 'X....', 'X....', 'X....', 'X.XX.', 'XX..X', 'X...X', 'X...X', 'X..X.', 'XXX..'],
    anchor: 8,
  },
  natural: {
    rows: ['X....', 'X....', 'X....', 'XXXXX', 'X...X', 'X...X', 'X...X', 'XXXXX', '....X', '....X', '....X'],
    anchor: 5,
  },
  accidentalW: 8,
  keyAdvance: 7,
  restQuarter: scaleGlyph(MEDIUM.restQuarter, 4 / 3),
  restEighth: scaleGlyph(MEDIUM.restEighth, 4 / 3),
  fermata: scaleSprite(FERMATA, 4 / 3),
  dot: 3,
  clef: scaleGlyph(MEDIUM.clef, 4 / 3),
  quarterPx: 24,
  minSlotPx: 18,
  ledgerOverhang: 3,
};

export const NOTE_GLYPHS: Record<Size, NoteGlyphs> = { small: SMALL, medium: MEDIUM, large: LARGE };
export const LYRIC_FONTS: Record<Size, BitmapFont> = { small: FONT_5X8, medium: FONT_7X10, large: FONT_8X12 };

/** Where things sit in a band, for one set of options. Rows are relative to the band top. */
export type Geometry = {
  opts: EngraveOptions;
  n: NoteGlyphs;
  font: BitmapFont;
  bandH: number;
  bandsPerClip: number;
  /** Rows of the top and bottom staff lines. */
  staffTop: number;
  staffBottom: number;
  /** Rows per diatonic step (half the pitch). */
  step: number;
  lyricY: number;
};

/**
 * The lyric row sits at the bottom of the band. The staff starts 2px from the
 * top; any room left over below two ledger lines is split evenly above and
 * below the staff, so a roomy band does not bunch everything at the top.
 */
export function geometry(opts: EngraveOptions = DEFAULT_OPTIONS): Geometry {
  const n = NOTE_GLYPHS[opts.notes];
  const font = LYRIC_FONTS[opts.font];
  const bandH = SCREEN_H / opts.staves;
  const staffH = 4 * n.pitch;
  const headH = n.headFilled.length;
  const lyricY = bandH - font.h;
  const spare = lyricY - (2 + staffH + 2 * n.pitch + Math.ceil(headH / 2));
  const staffTop = 2 + Math.max(0, Math.floor(spare / 2));
  return {
    opts,
    n,
    font,
    bandH,
    bandsPerClip: CLIP_H / bandH,
    staffTop,
    staffBottom: staffTop + staffH,
    step: n.pitch / 2,
    lyricY,
  };
}

export const DEFAULT_GEOMETRY = geometry(DEFAULT_OPTIONS);

// The default geometry's numbers, for tests and callers that only need the default.
export const BAND_H = DEFAULT_GEOMETRY.bandH;
export const STAFF_TOP = DEFAULT_GEOMETRY.staffTop;
export const STAFF_BOTTOM = DEFAULT_GEOMETRY.staffBottom;
export const LINE_PITCH = MEDIUM.pitch;
export const STEP_PX = DEFAULT_GEOMETRY.step;
export const LYRIC_Y = DEFAULT_GEOMETRY.lyricY;
export const BANDS_PER_CLIP = DEFAULT_GEOMETRY.bandsPerClip;
export const QUARTER_PX = MEDIUM.quarterPx;
export const MIN_SLOT_PX = MEDIUM.minSlotPx;
export const STEM_LEN = MEDIUM.stemLen;
export const ACCIDENTAL_W = MEDIUM.accidentalW;
export const LEDGER_OVERHANG = MEDIUM.ledgerOverhang;
/** Gap a syllable keeps before the next notehead. */
export const LYRIC_GAP = 4;
export const MEASURE_PAD_LEFT = 4;
export const MEASURE_PAD_RIGHT = 2;

// ── Roles and tint ─────────────────────────────────────────────────────────

/**
 * The engraver draws three roles: staff lines at `STAFF_LINE_GREY`, ledger
 * lines at `LEDGER_GREY`, everything else (ink) at 255. `tint` maps each role
 * to a style's grey before a clip is sent. The raw values are themselves usable
 * dim greys (the phone's score view shows the strip untinted): the host
 * quantises 8-bit grey to 16 levels, and 20 lands on level 1 whether it
 * truncates (20 >> 4) or rounds (20 / 17); 40 lands on level 2 either way.
 */
export const STAFF_LINE_GREY = 20;
export const LEDGER_GREY = 40;

/** 8-bit grey for G2 level 0–15; 17·n lands on level n whether the host truncates or rounds. */
export const level = (n: number): number => 17 * n;

export type Palette = { line: number; ledger: number; ink: number };

/**
 * The half being sung is bright; the next half is dim enough to read as "not
 * yet" but still legible. A short isolated ledger line looks dimmer than a
 * full-width staff line at the same grey, so ledgers sit two levels above
 * the staff to read as the same brightness. Ink is never below a ledger, so
 * noteheads on ledger lines keep their shape.
 */
export const PALETTE: Record<'current' | 'next', Palette> = {
  current: { line: level(3), ledger: level(5), ink: level(15) },
  next: { line: level(1), ledger: level(3), ink: level(3) },
};

/** A copy of `b` with each role at its grey in `p`. */
export function tint(b: Bitmap, p: Palette): Bitmap {
  const lut = new Uint8Array(256).fill(p.ink);
  lut[0] = 0;
  lut[STAFF_LINE_GREY] = p.line;
  lut[LEDGER_GREY] = p.ledger;
  const out = createBitmap(b.width, b.height);
  for (let i = 0; i < b.data.length; i++) out.data[i] = lut[b.data[i]];
  return out;
}

/** Row (inside a band) of a notehead centre on `step`. Even steps are lines. */
export function rowOfStep(step: number, g: Geometry = DEFAULT_GEOMETRY): number {
  return g.staffBottom - step * g.step;
}

/** Key-signature glyph steps, in the order they are written on a treble staff. */
const SHARP_STEPS = [8, 5, 9, 6, 3, 7, 4];
const FLAT_STEPS = [4, 7, 3, 6, 2, 5, 1];

// ── Layout ─────────────────────────────────────────────────────────────────

export type LaidNote = {
  note: NoteEvent;
  /** x of the notehead's left edge (or the rest's), absolute in the line. */
  x: number;
  /** Slot width from `x` to the next note. */
  slot: number;
};

export type LaidMeasure = {
  measure: Measure;
  x: number;
  width: number;
  notes: LaidNote[];
  /** Key signature shown inline at this measure (a change mid-line). */
  keyChange?: number;
};

export type Line = {
  index: number;
  /** Key signature in force at the start of the line. */
  fifths: number;
  measures: LaidMeasure[];
  /** Used width, including the final barline. */
  width: number;
};

export function durationPx(duration: number, divisions: number, n: NoteGlyphs = MEDIUM): number {
  return Math.max(n.minSlotPx, Math.round((n.quarterPx * duration) / divisions));
}

function keySigWidth(fifths: number, n: NoteGlyphs): number {
  return Math.abs(fifths) * n.keyAdvance;
}

function leadingWidth(fifths: number, n: NoteGlyphs): number {
  return 1 + n.clef.rows[0].length + 3 + keySigWidth(fifths, n) + (fifths ? 3 : 0);
}

/** Lay out one measure's notes starting at x = 0; returns notes and total width. */
function layoutMeasure(m: Measure, divisions: number, g: Geometry, inlineKey?: number): { notes: LaidNote[]; width: number } {
  const { n } = g;
  let x = MEASURE_PAD_LEFT + (inlineKey !== undefined ? keySigWidth(inlineKey, n) + 3 : 0);
  const notes: LaidNote[] = [];
  for (const note of m.notes) {
    const pre = note.accidental ? n.accidentalW : 0;
    let slot = durationPx(note.duration, divisions, n);
    if (note.lyric) slot = Math.max(slot, textWidth(note.lyric.text, g.font) + LYRIC_GAP);
    x += pre;
    notes.push({ note, x, slot });
    x += slot;
  }
  return { notes, width: x + MEASURE_PAD_RIGHT + 1 };
}

export function layoutScore(score: Score, g: Geometry = DEFAULT_GEOMETRY, lineWidth = LINE_W): Line[] {
  const lines: Line[] = [];
  let fifths = 0;
  let current: Line | null = null;
  let cursor = 0;

  const open = () => {
    current = { index: lines.length, fifths, measures: [], width: 0 };
    lines.push(current);
    cursor = leadingWidth(fifths, g.n);
  };

  for (const m of score.measures) {
    const keyChange = m.fifths !== undefined && m.fifths !== fifths ? m.fifths : undefined;
    if (!current) {
      if (keyChange !== undefined) fifths = keyChange;
      open();
    }
    const inline = keyChange !== undefined && current!.measures.length > 0 ? keyChange : undefined;
    let laid = layoutMeasure(m, score.divisions, g, inline);
    if (current!.measures.length > 0 && cursor + laid.width > lineWidth) {
      if (keyChange !== undefined) fifths = keyChange;
      open();
      laid = layoutMeasure(m, score.divisions, g);
    } else if (keyChange !== undefined) {
      fifths = keyChange;
      if (current!.measures.length === 0) {
        current!.fifths = fifths;
        cursor = leadingWidth(fifths, g.n);
        laid = layoutMeasure(m, score.divisions, g);
      }
    }
    const placed: LaidMeasure = {
      measure: m,
      x: cursor,
      width: laid.width,
      notes: laid.notes.map((n) => ({ ...n, x: n.x + cursor })),
      keyChange: inline,
    };
    current!.measures.push(placed);
    cursor += laid.width;
    current!.width = cursor;
  }
  return lines;
}

// ── Rendering ──────────────────────────────────────────────────────────────

function drawGlyph(b: Bitmap, x: number, row: number, glyph: Glyph): void {
  drawSprite(b, x, row - glyph.anchor, glyph.rows);
}

function drawKeySignature(b: Bitmap, x: number, y0: number, fifths: number, g: Geometry): number {
  const steps = fifths > 0 ? SHARP_STEPS : FLAT_STEPS;
  const glyph = fifths > 0 ? g.n.sharp : g.n.flat;
  for (let i = 0; i < Math.abs(fifths); i++) drawGlyph(b, x + i * g.n.keyAdvance, y0 + rowOfStep(steps[i], g), glyph);
  return keySigWidth(fifths, g.n);
}

/**
 * Ledger lines take their own role, drawn only on unlit pixels so they never
 * dim ink. They overhang the head on each side so they read as lines, not
 * part of the note.
 */
function drawLedgerLines(b: Bitmap, x: number, y0: number, step: number, headW: number, g: Geometry): void {
  const over = g.n.ledgerOverhang;
  const ledger = (row: number) => {
    const y = y0 + row;
    if (y < 0 || y >= b.height) return;
    for (let px = Math.max(0, x - over); px < Math.min(b.width, x + headW + over); px++) {
      if (!b.data[y * b.width + px]) b.data[y * b.width + px] = LEDGER_GREY;
    }
  };
  for (let s = -2; s >= step; s -= 2) ledger(rowOfStep(s, g));
  for (let s = 10; s <= step; s += 2) ledger(rowOfStep(s, g));
}

/** A shallow 1px arc from (x1, y1) to (x2, y2), bowing by `sag` rows (positive = downward). */
export function drawArc(b: Bitmap, x1: number, y1: number, x2: number, y2: number, sag: number): void {
  const n = Math.max(1, x2 - x1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const y = Math.round(y1 + (y2 - y1) * t + sag * 4 * t * (1 - t));
    const px = x1 + i;
    if (px >= 0 && px < b.width && y >= 0 && y < b.height) b.data[y * b.width + px] = 255;
  }
}

function drawRest(b: Bitmap, laid: LaidNote, measure: LaidMeasure, y0: number, g: Geometry): void {
  const { n } = g;
  const { note } = laid;
  const headW = n.headFilled[0].length;
  const half = Math.floor(headW / 2);
  const centreX = note.measureRest ? measure.x + Math.floor(measure.width / 2) : laid.x + half;
  const type = note.measureRest ? 'whole' : note.type;
  const top = y0 + g.staffTop;
  const blockH = n.pitch / 2;
  const sprite = (glyph: Glyph) => drawSprite(b, centreX - Math.floor(glyph.rows[0].length / 2), top + glyph.anchor, glyph.rows);
  if (type === 'whole') fillRect(b, centreX - half, top + n.pitch + 1, headW, blockH);
  else if (type === 'half') fillRect(b, centreX - half, top + 2 * n.pitch - blockH, headW, blockH);
  else if (type === 'quarter') sprite(n.restQuarter);
  else sprite(n.restEighth);
  if (note.dots) fillRect(b, centreX + half + 2, top + 2 * n.pitch - blockH, n.dot, n.dot);
}

function drawNote(b: Bitmap, laid: LaidNote, y0: number, g: Geometry): { headX: number; cy: number; stemUp: boolean } {
  const { n } = g;
  const { note, x } = laid;
  const step = note.step ?? 0;
  const cy = y0 + rowOfStep(step, g);
  const stemUp = note.stem !== 'down';
  const head = note.type === 'whole' ? n.headWhole : note.type === 'half' ? n.headHollow : n.headFilled;
  const headW = head[0].length;
  const headH = head.length;
  drawLedgerLines(b, x, y0, step, headW, g);
  if (note.accidental) {
    const glyph = note.accidental === 'sharp' ? n.sharp : note.accidental === 'flat' ? n.flat : n.natural;
    drawGlyph(b, x - n.accidentalW, cy, glyph);
  }
  drawSprite(b, x, cy - Math.floor(headH / 2), head);
  if (note.type !== 'whole') {
    const flagged = note.type === 'eighth' || note.type === '16th';
    if (stemUp) {
      fillRect(b, x + headW - 1, cy - n.stemLen, 1, n.stemLen);
      if (flagged) drawSprite(b, x + headW, cy - n.stemLen, n.flag);
    } else {
      fillRect(b, x, cy + 1, 1, n.stemLen);
      if (flagged) drawSprite(b, x + 1, cy + n.stemLen - (n.flag.length - 1), [...n.flag].reverse());
    }
  }
  for (let d = 0; d < note.dots; d++) {
    // On a line the dot moves up into the space; in a space it sits on the centre row.
    const dotRow = step % 2 === 0 ? cy - g.step - Math.floor((n.dot - 1) / 2) : cy - Math.floor(n.dot / 2);
    fillRect(b, x + headW + 1 + d * (n.dot + 1), dotRow, n.dot, n.dot);
  }
  if (note.fermata) drawSprite(b, x, Math.max(y0, cy - n.stemLen - (n.fermata.length + 2)), n.fermata);
  return { headX: x, cy, stemUp };
}

/**
 * Render laid-out lines into a strip `LINE_W` wide and a whole number of clip
 * rows tall, so slicing needs no edge case.
 */
export function renderLines(lines: Line[], g: Geometry = DEFAULT_GEOMETRY): Bitmap {
  const { n, font } = g;
  const headW = n.headFilled[0].length;
  const headH = n.headFilled.length;
  const arcOff = Math.floor(headH / 2) + 2;
  const tieSag = Math.round(n.pitch / 2);
  const slurSag = Math.round((2 * n.pitch) / 3);
  const arcFrom = headW - 3;
  const arcTo = Math.floor(headW / 2) - 1;
  const clipRows = Math.max(1, Math.ceil(lines.length / g.bandsPerClip));
  const b = createBitmap(LINE_W, clipRows * CLIP_H);
  lines.forEach((line, li) => {
    const y0 = li * g.bandH;
    for (let i = 0; i < 5; i++) fillRect(b, 0, y0 + g.staffTop + i * n.pitch, LINE_W, 1, STAFF_LINE_GREY);
    drawSprite(b, 1, y0 + g.staffTop + n.clef.anchor, n.clef.rows);
    drawKeySignature(b, 1 + n.clef.rows[0].length + 3, y0, line.fifths, g);

    let pendingTie: { x: number; cy: number; below: boolean } | null = null;
    for (const measure of line.measures) {
      if (measure.keyChange !== undefined) drawKeySignature(b, measure.x + MEASURE_PAD_LEFT, y0, measure.keyChange, g);
      let pendingSlur: { x: number; cy: number; below: boolean } | null = null;
      for (const laid of measure.notes) {
        const { note } = laid;
        if (note.rest) {
          drawRest(b, laid, measure, y0, g);
          continue;
        }
        const { headX, cy, stemUp } = drawNote(b, laid, y0, g);
        const below = stemUp; // ties and slurs go on the side away from the stem
        const arcY = below ? cy + arcOff : cy - arcOff;
        if (note.tieStop && pendingTie) {
          drawArc(b, pendingTie.x + arcFrom, pendingTie.cy, headX + arcTo, arcY, pendingTie.below ? tieSag : -tieSag);
          pendingTie = null;
        } else if (note.tieStop) {
          drawArc(b, measure.x, arcY, headX + arcTo, arcY, below ? tieSag : -tieSag); // continued from the previous line
        }
        if (note.slurStop && pendingSlur) {
          drawArc(b, pendingSlur.x + arcFrom, pendingSlur.cy, headX + arcTo, arcY, pendingSlur.below ? slurSag : -slurSag);
          pendingSlur = null;
        }
        if (note.tieStart) pendingTie = { x: headX, cy: arcY, below };
        if (note.slurStart) pendingSlur = { x: headX, cy: arcY, below };
        if (note.lyric) {
          const lx = headX - 1;
          drawText(b, lx, y0 + g.lyricY, note.lyric.text, 255, font);
          if (note.lyric.syllabic === 'begin' || note.lyric.syllabic === 'middle') {
            const end = lx + textWidth(note.lyric.text, font);
            const gap = headX + laid.slot - end;
            if (gap >= 7) fillRect(b, end + Math.floor((gap - 3) / 2), y0 + g.lyricY + Math.floor(font.h / 2), 3, 1);
          }
        }
      }
      const barX = measure.x + measure.width - 1;
      fillRect(b, barX, y0 + g.staffTop, 1, g.staffBottom - g.staffTop + 1);
      if (pendingSlur) pendingSlur = null;
    }
    if (pendingTie) {
      // Tie continues onto the next line: draw a stub to the end of the measure.
      const last = line.measures[line.measures.length - 1];
      drawArc(b, pendingTie.x + arcFrom, pendingTie.cy, last.x + last.width - 2, pendingTie.cy, pendingTie.below ? tieSag : -tieSag);
    }
    if (li === lines.length - 1 && line.measures.length) {
      const last = line.measures[line.measures.length - 1];
      fillRect(b, last.x + last.width + 1, y0 + g.staffTop, 2, g.staffBottom - g.staffTop + 1);
    }
  });
  return b;
}

export type Engraved = { geometry: Geometry; lines: Line[]; strip: Bitmap; clips: Bitmap[] };

export function engrave(score: Score, opts: EngraveOptions = DEFAULT_OPTIONS): Engraved {
  const g = geometry(opts);
  const lines = layoutScore(score, g);
  const strip = renderLines(lines, g);
  return { geometry: g, lines, strip, clips: sliceClips(strip) };
}

/** Clip row holding the line that shows measure `index` (0-based in the score), or 0. */
export function rowOfMeasure(e: Pick<Engraved, 'lines' | 'geometry'>, index: number): number {
  let seen = 0;
  for (const line of e.lines) {
    seen += line.measures.length;
    if (index < seen) return Math.floor(line.index / e.geometry.bandsPerClip);
  }
  return 0;
}

/** Index in the score of the first measure shown in clip row `row`. */
export function firstMeasureOfRow(e: Pick<Engraved, 'lines' | 'geometry'>, row: number): number {
  const first = row * e.geometry.bandsPerClip;
  let index = 0;
  for (const line of e.lines) {
    if (line.index >= first) break;
    index += line.measures.length;
  }
  return index;
}

/** 288x144 clips in reading order: row 0 left, row 0 right, row 1 left, … */
export function sliceClips(strip: Bitmap): Bitmap[] {
  const rows = Math.ceil(strip.height / CLIP_H);
  const clips: Bitmap[] = [];
  for (let r = 0; r < rows; r++) {
    for (let side = 0; side < 2; side++) {
      const clip = createBitmap(CLIP_W, CLIP_H);
      for (let y = 0; y < CLIP_H; y++) {
        const sy = r * CLIP_H + y;
        if (sy >= strip.height) break;
        const from = sy * strip.width + side * CLIP_W;
        clip.data.set(strip.data.subarray(from, from + CLIP_W), y * CLIP_W);
      }
      clips.push(clip);
    }
  }
  return clips;
}

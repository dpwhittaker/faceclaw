import { GrayImage, type UiFont } from '../../../graphics/image';
import { normalizeWord } from '../../teleprompter/script-tracker';
import type { DocItem, MuseDocument, TextStyle } from './document';
import { DEFAULT_RANGE, geometry, layoutScore, renderLines, type StepRange } from './engrave';
import { textWidth } from './font5x8';
import type { ClefChoice, MuseSettings } from './front-matter';
import type { Score } from './score-types';
import { isLetter, NUMBER_CLASS } from '../../../util/unicode-class';

// The phone's V8 cannot parse \p{...} in a regex literal (see unicode-class.ts).
const NUMBER_RE = new RegExp(`[${NUMBER_CLASS}]`);

/**
 * Lays a document out as a column of rows, each one image: a line of text,
 * a system of music, a rule. Rows are as tall as their content, so text and
 * staves of any size mix. Each row image is drawn with GrayImage.drawImage,
 * so it goes to the glasses once and every later frame just moves it.
 *
 * The layout also lists the words a reader says or sings, in order, with
 * where each one is drawn: the speech tracker follows them, and the reader
 * scrolls to and underlines the next one.
 */

export type Row = {
  /** Left edge within the content column. */
  x: number;
  /** Top within the document. */
  y: number;
  height: number;
  image: GrayImage;
};

export type WordAnchor = {
  /** Index into `rows` of the row the word is drawn in. */
  row: number;
  x: number;
  width: number;
  /** Where an underline goes, from the row's top (in the gap below the word). */
  underlineY: number;
};

export type MuseLayout = {
  rows: Row[];
  height: number;
  /** Normalized words in reading order (see normalizeWord), for the tracker. */
  words: string[];
  /** Parallel to `words`. */
  anchors: WordAnchor[];
};

const STYLE_SCALE: Record<TextStyle, number> = { title: 1.4, heading: 1.2, subheading: 1.05, body: 1, code: 0.9 };
const STYLE_VALUE: Record<TextStyle, number> = { title: 255, heading: 255, subheading: 255, body: 220, code: 170 };
const QUOTE_VALUE = 190;
/** Stage directions: readable, but clearly not lines to say. */
const DIRECTION_VALUE = 100;
const MARKER_VALUE = 160;
const QUOTE_BAR_VALUE = 120;
const RULE_VALUE = 110;
/** Width of a quote's bar plus the space after it. */
const QUOTE_INSET = 14;

export function textSizeFor(style: TextStyle, bodySize: number): number {
  return Math.round(bodySize * STYLE_SCALE[style]);
}

/**
 * The score in the chosen clef. Changing clef moves the music by an octave
 * as well: a treble melody shown in bass sits an octave lower, where a
 * baritone sings it (treble's bottom line E4 becomes E3, step 5 in bass).
 */
export function withClef(score: Score, choice: ClefChoice): Score {
  if (choice === 'auto' || choice === score.clef) return score;
  const shift = choice === 'bass' ? 5 : -5;
  return {
    ...score,
    clef: choice,
    measures: score.measures.map((measure) => ({
      ...measure,
      notes: measure.notes.map((note) => {
        if (note.step === undefined) return note;
        const step = note.step + shift;
        return { ...note, step, stem: step >= 4 ? 'down' : 'up' };
      }),
    })),
  };
}

export function stepRange(score: Score): StepRange {
  let min = Infinity;
  let max = -Infinity;
  for (const measure of score.measures) {
    for (const note of measure.notes) {
      if (note.step === undefined) continue;
      min = Math.min(min, note.step);
      max = Math.max(max, note.step);
    }
  }
  return min === Infinity ? DEFAULT_RANGE : { min, max };
}

/** `width` is the content column; `fontAt` gives the body face at a pixel size. */
export function layoutDocument(
  doc: MuseDocument,
  settings: MuseSettings,
  width: number,
  fontAt: (sizePx: number) => UiFont,
): MuseLayout {
  const out: MuseLayout = { rows: [], height: 0, words: [], anchors: [] };
  const bodyLine = fontAt(settings.text).lineHeight;
  let y = 0;
  let previous: DocItem | null = null;
  for (const item of doc.items) {
    if (previous) y += gapBefore(item, previous, bodyLine, settings);
    if (item.kind === 'text') y = layoutText(out, item, y, width, settings.text, fontAt);
    else if (item.kind === 'music') y = layoutMusic(out, item.score, y, width, settings);
    else {
      const ruleWidth = Math.round(width * 0.6);
      const image = new GrayImage(ruleWidth, 1, 0);
      image.fillRect(0, 0, ruleWidth, 1, RULE_VALUE);
      out.rows.push({ x: Math.round((width - ruleWidth) / 2), y, height: 1, image });
      y += 1;
    }
    previous = item;
  }
  out.height = y;
  return out;
}

function gapBefore(item: DocItem, previous: DocItem, bodyLine: number, settings: MuseSettings): number {
  if (item.kind === 'music' && previous.kind === 'music') {
    return Math.round(288 / settings.staves / 3); // between verses
  }
  if (item.kind === 'text' && item.style !== 'body' && item.style !== 'code') return Math.round(bodyLine * 0.8);
  // List items sit closer together than paragraphs.
  if (item.kind === 'text' && item.marker && previous.kind === 'text' && previous.marker) return Math.round(bodyLine * 0.2);
  return Math.round(bodyLine * 0.45);
}

type TextItem = Extract<DocItem, { kind: 'text' }>;

/** A word as written, and whether it is a stage direction (shown dim, never listened for). */
export type TextWord = { text: string; direction: boolean };

/**
 * A paragraph's words, line by line. A word is a stage direction when all of
 * its letters sit inside [brackets] or (parentheses): "[wonder]", or every
 * word of "(She is holding a walkie-talkie.)". Nesting carries across line
 * breaks but not past the paragraph, so a stray "(" dims one paragraph at most.
 */
export function textWords(text: string): TextWord[][] {
  let depth = 0;
  return text.split('\n').map((line) => {
    const words: TextWord[] = [];
    for (const word of line.split(/\s+/)) {
      if (!word) continue;
      let spoken = false;
      let inside = false;
      for (const c of word) {
        if (c === '[' || c === '(') depth++;
        else if (c === ']' || c === ')') depth = Math.max(0, depth - 1);
        else if (isLetter(c) || NUMBER_RE.test(c)) {
          if (depth > 0) inside = true;
          else spoken = true;
        }
      }
      words.push({ text: word, direction: inside && !spoken });
    }
    return words;
  });
}

type WrappedLine = { text: string; words: TextWord[]; starts: number[] };

/** Greedy word wrap; '\n' always breaks. Each line keeps where its words start. */
function wrap(lines: TextWord[][], font: UiFont, maxWidth: number): WrappedLine[] {
  const out: WrappedLine[] = [];
  for (const words of lines) {
    let line: WrappedLine = { text: '', words: [], starts: [] };
    for (const word of words) {
      const candidate = line.text ? `${line.text} ${word.text}` : word.text;
      if (line.text && font.measureText(candidate) > maxWidth) {
        out.push(line);
        line = { text: word.text, words: [word], starts: [0] };
      } else {
        line.starts.push(line.text ? line.text.length + 1 : 0);
        line.words.push(word);
        line.text = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

/** Draw a wrapped line as runs of spoken words and of directions, each at its brightness. */
function drawLine(image: GrayImage, font: UiFont, x: number, line: WrappedLine, value: number): void {
  let runStart = 0;
  for (let w = 1; w <= line.words.length; w++) {
    if (w < line.words.length && line.words[w].direction === line.words[runStart].direction) continue;
    const from = line.starts[runStart];
    const to = line.starts[w - 1] + line.words[w - 1].text.length;
    const runValue = line.words[runStart].direction ? DIRECTION_VALUE : value;
    image.drawText(font, x + font.measureText(line.text.slice(0, from)), 0, line.text.slice(from, to), runValue);
    runStart = w;
  }
}

function layoutText(
  out: MuseLayout,
  item: TextItem,
  top: number,
  width: number,
  bodySize: number,
  fontAt: (sizePx: number) => UiFont,
): number {
  const font = fontAt(textSizeFor(item.style, bodySize));
  const lineHeight = font.lineHeight;
  const rowHeight = lineHeight + Math.max(2, Math.round(lineHeight * 0.15));
  const rowX = item.indent * Math.round(bodySize * 1.2);
  const quoteInset = item.quote ? QUOTE_INSET : 0;
  const markerWidth = item.marker ? font.measureText(`${item.marker} `) : 0;
  const textX = quoteInset + markerWidth;
  const value = item.quote ? QUOTE_VALUE : STYLE_VALUE[item.style];
  let y = top;
  wrap(textWords(item.text), font, Math.max(40, width - rowX - textX)).forEach((line, index) => {
    const marker = index === 0 ? item.marker : undefined;
    if (line.text || marker || item.quote) {
      const image = new GrayImage(Math.max(1, textX + font.measureText(line.text)), rowHeight, 0);
      if (item.quote) image.fillRect(0, 0, 2, rowHeight, QUOTE_BAR_VALUE);
      if (marker) image.drawText(font, quoteInset, 0, marker, MARKER_VALUE);
      if (line.text) drawLine(image, font, textX, line, value);
      const row = out.rows.length;
      out.rows.push({ x: rowX, y, height: rowHeight, image: image.withDrawsBaked() });
      line.words.forEach((word, w) => {
        const key = word.direction ? '' : normalizeWord(word.text);
        if (!key) return;
        out.words.push(key);
        out.anchors.push({
          row,
          x: rowX + textX + font.measureText(line.text.slice(0, line.starts[w])),
          width: font.measureText(word.text),
          underlineY: lineHeight,
        });
      });
    }
    y += rowHeight;
  });
  return y;
}

function layoutMusic(out: MuseLayout, original: Score, top: number, width: number, settings: MuseSettings): number {
  const score = withClef(original, settings.clef);
  const g = geometry({ staves: settings.staves, notes: settings.notes, font: settings.lyrics }, stepRange(score));
  const lines = layoutScore(score, g, width);
  if (!lines.length) return top;
  const strip = renderLines(lines, g, width);
  const firstRow = out.rows.length;
  lines.forEach((_, li) => {
    const band = new GrayImage(width, g.bandH, 0);
    const start = li * g.bandH;
    const rows = Math.min(g.bandH, strip.height - start);
    if (rows > 0) band.pixels.set(strip.data.subarray(start * width, (start + rows) * width));
    out.rows.push({ x: 0, y: top + li * g.bandH, height: g.bandH, image: band });
  });

  // A sung word is a run of syllables from begin to end; it is anchored at
  // its first syllable, whose underline goes just below the band (the next
  // band's first rows are clear of its staff).
  let word: { text: string; anchor: WordAnchor } | null = null;
  const finish = () => {
    const key = word ? normalizeWord(word.text) : '';
    if (word && key) {
      out.words.push(key);
      out.anchors.push(word.anchor);
    }
    word = null;
  };
  lines.forEach((line, li) => {
    for (const measure of line.measures) {
      for (const laid of measure.notes) {
        const lyric = laid.note.lyric;
        if (!lyric) continue;
        if (lyric.syllabic === 'single' || lyric.syllabic === 'begin' || !word) {
          finish();
          word = {
            text: '',
            anchor: { row: firstRow + li, x: laid.x - 1, width: textWidth(lyric.text, g.font), underlineY: g.bandH },
          };
        }
        word!.text += lyric.text;
        if (lyric.syllabic === 'single' || lyric.syllabic === 'end') finish();
      }
    }
  });
  finish();
  return top + lines.length * g.bandH;
}

import type { Accidental, Clef, Measure, NoteEvent, NoteType, Score, Syllabic } from './score-types';

/**
 * ABC notation (abcnotation.com, standard 2.1) to engraver Scores, for one
 * melody line. Read: the header fields T:, M:, L:, K: (key, mode, clef and
 * middle=), notes with accidentals, octave marks, lengths, broken rhythm,
 * ties, slurs, tuplets, rests (z, Z), bar lines, chords (their top note),
 * the fermata decoration, inline [K:]/[L:]/[M:] fields, lyrics (w:) and the
 * words after the tune (W:). Skipped: grace notes, chord symbols, other
 * decorations, invisible rests and spacers, and every voice after the first.
 *
 * Several w: lines under the same music are verses (the standard's "first
 * time, second time"). Muse reads top to bottom, so each verse becomes its
 * own pass through the tune: `verses` holds one Score per verse. A w: group
 * with a single line (a refrain) is sung in every pass.
 */

export type AbcTune = {
  title: string;
  /** One Score per verse; a single Score when there are no stacked verses. */
  verses: Score[];
  /** W: lines, printed after the tune ('' = a stanza break). */
  words: string[];
};

/** Divisions per quarter note: room for sixteenths and triplets of them. */
export const DIVISIONS = 48;

const LETTERS = 'CDEFGAB';
/** Fifths of each natural tonic's major key. */
const LETTER_FIFTHS: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const MODE_FIFTHS: Record<string, number> = {
  maj: 0, ion: 0, m: -3, min: -3, aeo: -3, mix: -1, dor: -2, phr: -4, lyd: 1, loc: -5,
};
const SHARP_ORDER = 'FCGDAEB';

/** Diatonic number of a pitch: octave * 7 + letter index, so C4 = 28. */
function diatonic(letter: string, octave: number): number {
  return octave * 7 + LETTERS.indexOf(letter.toUpperCase());
}

/** Parse an ABC pitch like `B`, `D,` or `c'` to its diatonic number, or null. */
function parsePitch(text: string): number | null {
  const m = /^([A-Ga-g])([',]*)/.exec(text.trim());
  if (!m) return null;
  let octave = m[1] === m[1].toUpperCase() ? 4 : 5;
  for (const mark of m[2]) octave += mark === "'" ? 1 : -1;
  return diatonic(m[1], octave);
}

type KeyInfo = { fifths: number; clef?: Clef; middle?: number };

/** A K: (or V:) value: key and mode, then clef and middle= among the rest. */
export function parseKey(value: string): KeyInfo {
  let rest = value.trim();
  let fifths = 0;
  const tonic = /^([A-G])([#b]?)/.exec(rest);
  if (tonic) {
    fifths = LETTER_FIFTHS[tonic[1]] + (tonic[2] === '#' ? 7 : tonic[2] === 'b' ? -7 : 0);
    rest = rest.slice(tonic[0].length);
    const mode = /^\s*([A-Za-z]+)/.exec(rest);
    if (mode) {
      const word = mode[1].toLowerCase();
      const key = word === 'm' ? 'm' : word.slice(0, 3);
      if (key in MODE_FIFTHS) {
        fifths += MODE_FIFTHS[key];
        rest = rest.slice(mode[0].length);
      }
    }
  }
  return { fifths: Math.max(-7, Math.min(7, fifths)), ...parseClefTokens(rest) };
}

function parseClefTokens(text: string): { clef?: Clef; middle?: number } {
  const out: { clef?: Clef; middle?: number } = {};
  for (const token of text.trim().split(/\s+/)) {
    const name = /^(?:clef=)?([a-z]+)/.exec(token)?.[1];
    if (token.startsWith('middle=')) {
      const middle = parsePitch(token.slice('middle='.length));
      if (middle !== null) out.middle = middle;
    } else if (name === 'bass') {
      out.clef = 'bass';
    } else if (name === 'treble' || name === 'alto' || name === 'tenor') {
      // Alto and tenor have no glyph here; treble shows the same pitches.
      out.clef = 'treble';
    }
  }
  return out;
}

/** M: as a fraction of a whole note (4/4 = 1), or null for free meter. */
function parseMeter(value: string): number | null {
  const v = value.trim();
  if (v === 'C') return 1;
  if (v === 'C|') return 1;
  const m = /^([\d+]+)\s*\/\s*(\d+)/.exec(v);
  if (!m) return null;
  const top = m[1].split('+').reduce((sum, part) => sum + (parseInt(part, 10) || 0), 0);
  return top / parseInt(m[2], 10);
}

/** L: as a fraction of a whole note. */
function parseUnit(value: string): number | null {
  const m = /^(\d+)(?:\s*\/\s*(\d+))?/.exec(value.trim());
  if (!m) return null;
  return parseInt(m[1], 10) / (m[2] ? parseInt(m[2], 10) : 1);
}

/** Note shape for a length in divisions: exact plain, dotted or double-dotted values, else the largest that fits. */
function noteShape(divisions: number): { type: NoteType; dots: number } {
  const bases: [NoteType, number][] = [
    ['whole', 4 * DIVISIONS], ['half', 2 * DIVISIONS], ['quarter', DIVISIONS], ['eighth', DIVISIONS / 2], ['16th', DIVISIONS / 4],
  ];
  for (const [type, base] of bases) {
    if (divisions === base) return { type, dots: 0 };
    if (divisions === base * 1.5) return { type, dots: 1 };
    if (divisions === base * 1.75) return { type, dots: 2 };
  }
  for (const [type, base] of bases) if (divisions >= base) return { type, dots: 0 };
  return { type: '16th', dots: 0 };
}

// ── Lyrics ─────────────────────────────────────────────────────────────────

type LyricToken =
  | { kind: 'syllable'; text: string; syllabic: Syllabic }
  | { kind: 'hold' }
  | { kind: 'skip' }
  | { kind: 'bar' };

/** Split a w: line into syllables and the alignment marks `_`, `*`, `|`, and a lone `-`. */
export function tokenizeLyrics(line: string): LyricToken[] {
  const tokens: LyricToken[] = [];
  let text = '';
  let hyphenBefore = false;
  const flush = (hyphenAfter: boolean) => {
    if (!text) return;
    const syllabic: Syllabic = hyphenBefore ? (hyphenAfter ? 'middle' : 'end') : hyphenAfter ? 'begin' : 'single';
    tokens.push({ kind: 'syllable', text, syllabic });
    text = '';
    hyphenBefore = hyphenAfter;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '-') {
      text += '-';
      i++;
    } else if (c === '~') {
      text += ' ';
    } else if (c === '-') {
      // After a space or another hyphen, a hyphen is a syllable of its own:
      // the word carries on over one more note.
      if (text) flush(true);
      else tokens.push({ kind: 'hold' });
    } else if (c === '_' || c === '*' || c === '|') {
      flush(false);
      tokens.push({ kind: c === '_' ? 'hold' : c === '*' ? 'skip' : 'bar' });
    } else if (/\s/.test(c)) {
      flush(false);
    } else {
      text += c;
    }
  }
  flush(false);
  return tokens;
}

type Lyric = { text: string; syllabic: Syllabic };
/** A note that takes syllables (not a rest), the bar it is in, and its lyric per verse. */
type LyricSlot = { note: NoteEvent; bar: number; verses: Lyric[] | null };

/** Align one w: line to slots[start…]; returns the index after the last slot it used. */
function alignLyrics(slots: LyricSlot[], start: number, line: string, verse: number, verseCount: number): number {
  let i = start;
  for (const token of tokenizeLyrics(line)) {
    if (token.kind === 'bar') {
      if (i > start) {
        const bar = slots[i - 1].bar;
        while (i < slots.length && slots[i].bar === bar) i++;
      }
      continue;
    }
    if (i >= slots.length) break;
    if (token.kind === 'syllable') {
      const slot = slots[i];
      slot.verses ??= new Array<Lyric>(verseCount);
      slot.verses[verse] = { text: token.text, syllabic: token.syllabic };
    }
    i++;
  }
  return i;
}

// ── Tunes ──────────────────────────────────────────────────────────────────

/**
 * Split a source into one string per tune. Each X: field starts a tune, and
 * a blank line after its music ends it; text up to the next X: is free text,
 * as is anything before the first X:. A source with no X: at all (a short
 * fragment in a Markdown file) is one tune, blank lines and all.
 */
function splitTunes(source: string): string[] {
  const tunes: string[] = [];
  let current: string[] | null = [];
  let fromX = false;
  let hasMusic = false;
  const push = () => {
    if (current && hasMusic) tunes.push(current.join('\n'));
    current = null;
    hasMusic = false;
  };
  for (const raw of source.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (/^X:/.test(line)) {
      if (fromX) push();
      current = [line];
      fromX = true;
      hasMusic = false;
      continue;
    }
    if (current === null) continue;
    if (!line.trim()) {
      if (fromX && hasMusic) push();
      continue;
    }
    if (!/^[A-Za-z+]:/.test(line) && !line.trimStart().startsWith('%')) hasMusic = true;
    current.push(line);
  }
  push();
  return tunes;
}

export function parseAbc(source: string): AbcTune[] {
  return splitTunes(source).map(parseTune);
}

function parseTune(source: string): AbcTune {
  let title = '';
  let meter: number | null = 1;
  let unit: number | null = null;
  let fifths = 0;
  let clef: Clef = 'treble';
  let middle: number | null = null;
  let inBody = false;
  const words: string[] = [];

  const measures: Measure[] = [];
  let measure: Measure = { number: '1', notes: [] };
  const slots: LyricSlot[] = [];
  // Consecutive w: lines, the slot where they start, and verses seen so far.
  let lyricGroup: string[] = [];
  let lyricStart = 0;
  let verseCount = 1;
  const groups: { start: number; end: number; size: number }[] = [];

  let voice: string | null = null;
  let inFirstVoice = true;

  // Pending marks for the next note, and the last note for marks that follow it.
  let slurStarts = 0;
  let tieStop = false;
  let fermata = false;
  let broken = 1;
  let tuplet = { left: 0, factor: 1 };
  let last: { note: NoteEvent; length: number; factor: number } | null = null;
  let barAccidentals = new Map<number, number>();
  let skipToBar = false;

  const unitLength = () => unit ?? (meter !== null && meter < 0.75 ? 1 / 16 : 1 / 8);
  /** Diatonic number on the bottom staff line: whatever middle= puts on the middle line, less two lines. */
  const staffBase = () => (middle ?? (clef === 'bass' ? diatonic('D', 3) : diatonic('B', 4))) - 4;

  const applyLength = (note: NoteEvent, length: number, factor: number) => {
    const nominal = Math.round(length * 4 * DIVISIONS);
    const shape = noteShape(nominal);
    note.type = shape.type;
    note.dots = shape.dots;
    note.duration = Math.max(1, Math.round(nominal * factor));
  };

  const closeMeasure = () => {
    if (!measure.notes.length) return;
    measures.push(measure);
    measure = { number: String(measures.length + 1), notes: [] };
    barAccidentals = new Map();
  };

  const setKey = (info: KeyInfo) => {
    if (info.fifths !== fifths || !measures.length) {
      fifths = info.fifths;
      measure.fifths = fifths;
    }
  };

  const flushLyrics = () => {
    if (!lyricGroup.length) return;
    let end = lyricStart;
    lyricGroup.forEach((line, verse) => {
      end = Math.max(end, alignLyrics(slots, lyricStart, line, verse, lyricGroup.length));
    });
    groups.push({ start: lyricStart, end, size: lyricGroup.length });
    verseCount = Math.max(verseCount, lyricGroup.length);
    lyricStart = end;
    lyricGroup = [];
  };

  /** Broken rhythm changes the written value; a tuplet only how much time (and room) the note takes. */
  const addNote = (note: NoteEvent, written: number) => {
    const length = written * broken;
    broken = 1;
    let factor = 1;
    if (tuplet.left > 0) {
      factor = tuplet.factor;
      tuplet.left--;
    }
    applyLength(note, length, factor);
    if (!note.rest) {
      if (slurStarts > 0) {
        note.slurStart = true;
        slurStarts = 0;
      }
      if (tieStop) note.tieStop = true;
      if (fermata) note.fermata = true;
      slots.push({ note, bar: measures.length, verses: null });
    }
    tieStop = false;
    fermata = false;
    measure.notes.push(note);
    last = { note, length, factor };
  };

  const makeNote = (step: number | undefined, accidental?: Accidental, alter = 0): NoteEvent => ({
    rest: step === undefined,
    measureRest: false,
    ...(step === undefined ? {} : { step }),
    alter,
    duration: 0,
    type: 'quarter',
    dots: 0,
    stem: step !== undefined && step >= 4 ? 'down' : 'up',
    ...(accidental ? { accidental } : {}),
    tieStart: false,
    tieStop: false,
    slurStart: false,
    slurStop: false,
    fermata: false,
  });

  /** Read a length suffix (`2`, `/`, `3/2`, `//`) at s[i]; returns [multiplier, next index]. */
  const readLength = (s: string, i: number): [number, number] => {
    const m = /^(\d*)(\/*)(\d*)/.exec(s.slice(i))!;
    let value = m[1] ? parseInt(m[1], 10) : 1;
    if (m[2]) value /= m[3] ? parseInt(m[3], 10) * 2 ** (m[2].length - 1) : 2 ** m[2].length;
    return [value, i + m[0].length];
  };

  /** Read one note (accidental, letter, octave marks, length) at s[i]; null if none is there. */
  const readPitch = (s: string, i: number): { step: number; accidental?: Accidental; alter: number; length: number; next: number } | null => {
    const m = /^(\^\^|\^|__|_|=)?([A-Ga-g])([',]*)/.exec(s.slice(i));
    if (!m) return null;
    let d = diatonic(m[2], m[2] === m[2].toUpperCase() ? 4 : 5);
    for (const mark of m[3]) d += mark === "'" ? 7 : -7;
    const explicit = m[1] === '^^' ? 2 : m[1] === '^' ? 1 : m[1] === '__' ? -2 : m[1] === '_' ? -1 : m[1] === '=' ? 0 : undefined;
    let alter: number;
    if (explicit !== undefined) {
      alter = explicit;
      barAccidentals.set(d, explicit);
    } else if (barAccidentals.has(d)) {
      alter = barAccidentals.get(d)!;
    } else {
      const letter = m[2].toUpperCase();
      const order = SHARP_ORDER.indexOf(letter);
      alter = fifths > 0 && order < fifths ? 1 : fifths < 0 && 6 - order < -fifths ? -1 : 0;
    }
    const accidental: Accidental | undefined = explicit === undefined ? undefined : explicit > 0 ? 'sharp' : explicit < 0 ? 'flat' : 'natural';
    const [mult, next] = readLength(s, i + m[0].length);
    return { step: d - staffBase(), accidental, alter, length: unitLength() * mult, next };
  };

  const inlineField = (name: string, value: string) => {
    if (name === 'K') {
      const info = parseKey(value);
      setKey(info);
    } else if (name === 'L') {
      unit = parseUnit(value) ?? unit;
    } else if (name === 'M') {
      meter = parseMeter(value);
    } else if (name === 'V') {
      const id = value.trim().split(/\s+/)[0] ?? '';
      voice ??= id;
      inFirstVoice = id === voice;
    }
  };

  const parseMusic = (line: string) => {
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      const rest = line.slice(i);
      if (c === '%') break;
      // Bar lines and repeats: |, ||, |], [|, |:, :|, ::, with ending numbers.
      if (c === '|' || (c === ':' && /^:+[|:]/.test(rest)) || rest.startsWith('[|')) {
        const m = /^(?:\[\||[|:])[|:\]]*[\d,-]*/.exec(rest)!;
        i += m[0].length;
        skipToBar = false;
        if (inFirstVoice) closeMeasure();
        continue;
      }
      if (c === '[' && /^\[[A-Za-z]:/.test(rest)) {
        const end = line.indexOf(']', i);
        const close = end < 0 ? line.length : end;
        inlineField(line[i + 1], line.slice(i + 3, close));
        i = close + 1;
        continue;
      }
      if (c === '[' && /^\[\d/.test(rest)) {
        i += /^\[[\d,-]+/.exec(rest)![0].length;
        continue;
      }
      if (!inFirstVoice || skipToBar) {
        i++;
        continue;
      }
      if (c === '"') {
        const end = line.indexOf('"', i + 1);
        i = end < 0 ? line.length : end + 1;
        continue;
      }
      if (c === '!' || c === '+') {
        const end = line.indexOf(c, i + 1);
        if (end < 0) {
          i++;
          continue;
        }
        if (/fermata/.test(line.slice(i + 1, end))) fermata = true;
        i = end + 1;
        continue;
      }
      if (c === '{') {
        const end = line.indexOf('}', i);
        i = end < 0 ? line.length : end + 1;
        continue;
      }
      if (c === 'H') {
        fermata = true;
        i++;
        continue;
      }
      if (c === '&') {
        skipToBar = true; // a second voice overlaid on this bar
        i++;
        continue;
      }
      if (c === '(') {
        const m = /^\((\d)(?::(\d*))?(?::(\d*))?/.exec(rest);
        if (m) {
          const p = parseInt(m[1], 10);
          const q = m[2] ? parseInt(m[2], 10) : ({ 2: 3, 4: 3, 8: 3 } as Record<number, number>)[p] ?? 2;
          tuplet = { left: m[3] ? parseInt(m[3], 10) : p, factor: q / p };
          i += m[0].length;
        } else {
          slurStarts++;
          i++;
        }
        continue;
      }
      if (c === ')') {
        if (last && !last.note.rest) last.note.slurStop = true;
        i++;
        continue;
      }
      if (c === '-') {
        if (last && !last.note.rest) {
          last.note.tieStart = true;
          tieStop = true;
        }
        i++;
        continue;
      }
      if (c === '>' || c === '<') {
        const m = /^(>+|<+)/.exec(rest)!;
        const shrink = 0.5 ** m[1].length;
        const [before, after] = c === '>' ? [2 - shrink, shrink] : [shrink, 2 - shrink];
        if (last) {
          last.length *= before;
          applyLength(last.note, last.length, last.factor);
        }
        broken = after;
        i += m[1].length;
        continue;
      }
      if (c === 'z') {
        const [mult, next] = readLength(line, i + 1);
        addNote(makeNote(undefined), unitLength() * mult);
        i = next;
        continue;
      }
      if (c === 'Z') {
        const m = /^Z(\d*)/.exec(rest)!;
        const bars = m[1] ? parseInt(m[1], 10) : 1;
        for (let b = 0; b < bars; b++) {
          if (b > 0) closeMeasure();
          const note = makeNote(undefined);
          note.measureRest = true;
          addNote(note, meter ?? 1);
        }
        i += m[0].length;
        continue;
      }
      if (c === 'x' || c === 'X' || c === 'y') {
        // Invisible rests and spacers take no room in a melody reader.
        i = readLength(line, i + 1)[1];
        continue;
      }
      if (c === '[') {
        // A chord: the melody is its top note.
        const end = line.indexOf(']', i);
        const close = end < 0 ? line.length : end;
        let top: ReturnType<typeof readPitch> = null;
        let first: number | null = null;
        for (let j = i + 1; j < close; ) {
          const pitch = readPitch(line, j);
          if (!pitch) {
            j++;
            continue;
          }
          first ??= pitch.length;
          if (!top || pitch.step > top.step) top = pitch;
          j = pitch.next;
        }
        const [mult, next] = readLength(line, close + 1);
        if (top) addNote(makeNote(top.step, top.accidental, top.alter), (first ?? unitLength()) * mult);
        i = next;
        continue;
      }
      const pitch = readPitch(line, i);
      if (pitch) {
        addNote(makeNote(pitch.step, pitch.accidental, pitch.alter), pitch.length);
        i = pitch.next;
        continue;
      }
      i++; // spaces, backquotes, line continuations, other decorations
    }
  };

  for (const raw of source.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trimStart().startsWith('%')) continue;
    const field = /^([A-Za-z+]):(.*)$/.exec(line);
    if (field) {
      const [, name, value] = field;
      if (name === 'w') {
        if (inFirstVoice) lyricGroup.push(value);
        continue;
      }
      if (name === '+' && lyricGroup.length) {
        lyricGroup[lyricGroup.length - 1] += ` ${value}`;
        continue;
      }
      flushLyrics();
      if (name === 'T' && !inBody && !title) title = value.trim();
      else if (name === 'W') words.push(value.trim());
      else if (name === 'K') {
        const info = parseKey(value);
        if (!inBody) {
          clef = info.clef ?? clef;
          middle = info.middle ?? middle;
        }
        setKey(info);
        inBody = true;
      } else if (name === 'V') {
        const id = value.trim().split(/\s+/)[0] ?? '';
        if (voice === null) {
          voice = id;
          const info = parseClefTokens(value.trim().slice(id.length));
          if (info.clef && !measures.length && !measure.notes.length) clef = info.clef;
          if (info.middle !== undefined) middle = info.middle;
        }
        inFirstVoice = id === voice;
      } else {
        inlineField(name, value);
      }
      continue;
    }
    flushLyrics();
    inBody = true;
    parseMusic(line.replace(/\\\s*$/, ''));
  }
  flushLyrics();
  closeMeasure();

  // One pass per verse; a group with a single w: line is sung every time.
  const verses: Score[] = [];
  for (let v = 0; v < verseCount; v++) {
    const lyricOf = new Map<NoteEvent, Lyric>();
    for (const group of groups) {
      for (let s = group.start; s < group.end; s++) {
        const lyric = slots[s].verses?.[group.size === 1 ? 0 : v];
        if (lyric) lyricOf.set(slots[s].note, lyric);
      }
    }
    verses.push({
      divisions: DIVISIONS,
      clef,
      measures: measures.map((m) => ({
        ...m,
        notes: m.notes.map((note) => {
          const copy: NoteEvent = { ...note };
          delete copy.lyric;
          const lyric = lyricOf.get(note);
          if (lyric) copy.lyric = lyric;
          return copy;
        }),
      })),
    });
  }
  return { title, verses, words };
}

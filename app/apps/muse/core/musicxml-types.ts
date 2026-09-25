// Types-only slice of sheet-music-test src/musicxml.ts (no DOM parser — Muse
// embeds a pre-parsed Score, see sample-score.ts).

export type NoteType = 'whole' | 'half' | 'quarter' | 'eighth' | '16th';
export type Syllabic = 'single' | 'begin' | 'middle' | 'end';
export type Accidental = 'sharp' | 'flat' | 'natural';

export type NoteEvent = {
  rest: boolean;
  /** `<rest measure="yes">`: the whole bar rests, drawn centred. */
  measureRest: boolean;
  /** Treble-staff step: 0 = E4 (bottom line), 1 = F4 … 8 = F5 (top line). Absent for rests. */
  step?: number;
  /** Chromatic alteration from `<alter>`: -1 flat, +1 sharp. */
  alter: number;
  /** In divisions of a quarter note (see `Score.divisions`). */
  duration: number;
  type: NoteType;
  dots: number;
  stem: 'up' | 'down';
  /** Only when the engraving shows one — key-signature sharps carry `alter` but no accidental. */
  accidental?: Accidental;
  tieStart: boolean;
  tieStop: boolean;
  slurStart: boolean;
  slurStop: boolean;
  fermata: boolean;
  lyric?: { text: string; syllabic: Syllabic };
};

export type Measure = {
  number: string;
  /** Key signature in fifths (+ sharps, − flats), when this measure changes it. */
  fifths?: number;
  beats?: number;
  beatType?: number;
  notes: NoteEvent[];
};

export type Score = {
  /** Divisions per quarter note. */
  divisions: number;
  measures: Measure[];
};


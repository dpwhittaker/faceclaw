// What the engraver draws: one melody line as measures of notes. The ABC
// reader (abc.ts) produces it; the shape began as sheet-music-test's MusicXML
// types.

export type NoteType = 'whole' | 'half' | 'quarter' | 'eighth' | '16th';
export type Syllabic = 'single' | 'begin' | 'middle' | 'end';
export type Accidental = 'sharp' | 'flat' | 'natural';
export type Clef = 'treble' | 'bass';

export type NoteEvent = {
  rest: boolean;
  /** A whole-bar rest, drawn centred. */
  measureRest: boolean;
  /** Staff step: 0 = the bottom line (E4 in treble, G2 in bass) … 8 = the top line. Absent for rests. */
  step?: number;
  /** Chromatic alteration: -1 flat, +1 sharp. */
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
  clef: Clef;
  measures: Measure[];
};

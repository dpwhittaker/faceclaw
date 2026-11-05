/**
 * Bridge from the engraver's 8-bit Bitmap to faceclaw's GrayImage, and the
 * split of a full engraved score into per-system bands.
 *
 * The engraver stacks one system per `geometry.bandH` rows from the top of the
 * strip (see core/engrave.ts renderLines: `y0 = li * bandH`), so the score is a
 * plain top-to-bottom column. Muse slices it into one GrayImage per system and
 * scrolls them as cached image draws (each band uploads to the on-glasses
 * texture atlas once, then moves by a small placement record — see
 * app/graphics/glyph-wire.ts). That is the whole reason Muse replaces the
 * EvenHub half-screen grid: on CFW a full score can smooth-scroll cheaply.
 */
import { GrayImage } from "../../../graphics/image";
import { type EngraveOptions, DEFAULT_OPTIONS, engrave } from "./engrave";
import { SAMPLE_SCORE } from "./sample-score";
import { type Score } from "./musicxml-types";

export type ScoreBands = {
  /** One GrayImage per engraved system, top to bottom. */
  bands: GrayImage[];
  /** Height of each band in px (`geometry.bandH`); the scroll step unit. */
  bandHeight: number;
  /** Full strip width (the engraver's 576px line width). */
  width: number;
  /** Total scrollable content height = bands.length * bandHeight. */
  totalHeight: number;
};

/** Copy an 8-bit engraver Bitmap into a GrayImage (0 stays transparent). */
export function bitmapToGray(b: { width: number; height: number; data: Uint8Array }): GrayImage {
  const img = new GrayImage(b.width, b.height, 0);
  img.pixels.set(b.data);
  return img;
}

/**
 * Engrave a score and cut it into per-system band images. `count` comes from
 * the engraved line list, not the padded strip height, so trailing blank
 * clip-padding is dropped.
 */
export function engraveToBands(score: Score = SAMPLE_SCORE, opts: EngraveOptions = DEFAULT_OPTIONS): ScoreBands {
  const eng = engrave(score, opts);
  const bandHeight = eng.geometry.bandH;
  const width = eng.strip.width;
  const count = eng.lines.length;
  const bands: GrayImage[] = [];
  for (let i = 0; i < count; i++) {
    const band = new GrayImage(width, bandHeight, 0);
    const top = i * bandHeight;
    // Copy the band's rows out of the strip; guard the last band against the
    // strip ending before a full bandHeight of padding.
    const rows = Math.min(bandHeight, eng.strip.height - top);
    if (rows > 0) {
      band.pixels.set(eng.strip.data.subarray(top * width, (top + rows) * width));
    }
    bands.push(band);
  }
  return { bands, bandHeight, width, totalHeight: count * bandHeight };
}

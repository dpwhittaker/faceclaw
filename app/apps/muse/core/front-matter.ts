import type { FileKind } from './document';
import type { Size, Staves } from './engrave';

/**
 * Muse's per-file display settings, kept in the file itself so they travel
 * with it. Markdown and text files carry them in YAML front matter (a `---`
 * block at the top, added when missing):
 *
 *     ---
 *     muse:
 *       text: 20
 *       lyrics: small
 *       notes: medium
 *       staves: 6
 *       clef: bass
 *     ---
 *
 * Front matter would break an ABC file for other ABC programs, so there it
 * is a stylesheet directive, which they ignore:
 * `%%muse text=20 lyrics=small notes=medium staves=6 clef=bass`.
 */

/** auto = as written; treble or bass redraws the music in that clef, moved by an octave. */
export type ClefChoice = 'auto' | 'treble' | 'bass';

export type MuseSettings = {
  /** Body text size in px; headings scale from it. */
  text: number;
  lyrics: Size;
  notes: Size;
  /** Staves per 288px of screen. */
  staves: Staves;
  clef: ClefChoice;
};

export const DEFAULT_SETTINGS: MuseSettings = { text: 20, lyrics: 'small', notes: 'medium', staves: 6, clef: 'auto' };
export const MIN_TEXT_SIZE = 10;
export const MAX_TEXT_SIZE = 48;

const SIZES: readonly Size[] = ['small', 'medium', 'large'];
const CLEFS: readonly ClefChoice[] = ['auto', 'treble', 'bass'];
const KEYS = ['text', 'lyrics', 'notes', 'staves', 'clef'] as const;

/** Settings from key/value strings; anything missing or invalid keeps its default. */
export function settingsFromValues(values: Record<string, string>): MuseSettings {
  const out = { ...DEFAULT_SETTINGS };
  const text = parseInt(values.text ?? '', 10);
  if (text >= MIN_TEXT_SIZE && text <= MAX_TEXT_SIZE) out.text = text;
  if (SIZES.includes(values.lyrics as Size)) out.lyrics = values.lyrics as Size;
  if (SIZES.includes(values.notes as Size)) out.notes = values.notes as Size;
  if (values.staves === '4' || values.staves === '6') out.staves = Number(values.staves) as Staves;
  if (CLEFS.includes(values.clef as ClefChoice)) out.clef = values.clef as ClefChoice;
  return out;
}

const unquote = (value: string) => value.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');

/** The front matter's line range: [first content line, closing line), or null when there is none. */
function frontMatterRange(lines: string[]): { start: number; end: number } | null {
  if (lines[0]?.replace(/^﻿/, '').trimEnd() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line === '---' || line === '...') return { start: 1, end: i };
  }
  return null;
}

/** Split off YAML front matter; abc files have none (their settings line is a comment). */
export function splitFrontMatter(text: string, kind: FileKind): { body: string; settings: MuseSettings } {
  const lines = text.split('\n');
  if (kind === 'abc') {
    const directive = lines.find((line) => /^%%muse\b/.test(line));
    const values: Record<string, string> = {};
    for (const pair of directive?.slice('%%muse'.length).trim().split(/\s+/) ?? []) {
      const [key, value] = pair.split('=');
      if (key && value !== undefined) values[key] = value;
    }
    return { body: text, settings: settingsFromValues(values) };
  }
  const range = frontMatterRange(lines);
  if (!range) return { body: text.replace(/^﻿/, ''), settings: DEFAULT_SETTINGS };
  return {
    body: lines.slice(range.end + 1).join('\n'),
    settings: settingsFromValues(museValues(lines.slice(range.start, range.end))),
  };
}

/** The `muse:` mapping in front-matter lines, block or flow style. */
function museValues(lines: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  const at = lines.findIndex((line) => /^muse:/.test(line));
  if (at < 0) return values;
  const flow = /^muse:\s*\{(.*)\}\s*$/.exec(lines[at]);
  if (flow) {
    for (const pair of flow[1].split(',')) {
      const m = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(pair);
      if (m) values[m[1]] = unquote(m[2]);
    }
    return values;
  }
  for (let i = at + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) {
    const m = /^\s+(\w+)\s*:\s*(.*?)\s*$/.exec(lines[i]);
    if (m) values[m[1]] = unquote(m[2]);
  }
  return values;
}

/**
 * The file's text with `settings` written in: the `muse:` block replaced (or
 * added to the front matter, or a front matter added), keeping every other
 * line and the file's line endings.
 */
export function writeSettings(text: string, kind: FileKind, settings: MuseSettings): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (kind === 'abc') {
    const directive = `%%muse ${KEYS.map((key) => `${key}=${settings[key]}`).join(' ')}`;
    const at = lines.findIndex((line) => /^%%muse\b/.test(line));
    if (at >= 0) lines[at] = directive;
    else lines.unshift(directive);
    return lines.join(eol);
  }
  const block = ['muse:', ...KEYS.map((key) => `  ${key}: ${settings[key]}`)];
  const range = frontMatterRange(lines);
  if (!range) return ['---', ...block, '---', ...lines].join(eol);
  const at = lines.findIndex((line, i) => i >= range.start && i < range.end && /^muse:/.test(line));
  if (at < 0) {
    lines.splice(range.end, 0, ...block);
  } else {
    let end = at + 1;
    if (!/^muse:\s*\{/.test(lines[at])) while (end < range.end && /^\s+\S/.test(lines[end])) end++;
    lines.splice(at, end - at, ...block);
  }
  return lines.join(eol);
}

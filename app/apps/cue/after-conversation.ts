import { identify, pool, scoreCandidates, type PrintStore } from "./voiceprints";

/**
 * After a conversation: naming who said each live line, for the hand-off.
 * Live transcription found the turns; each run of one live voice is then
 * voice-printed from the recording and matched against the people Cue
 * knows. A confident match names the run even against the name the live
 * voice was given (live numbers get reused for someone else); otherwise
 * the live name stands, as a guess unless the wearer confirmed it. Pure,
 * so it runs under node tests; cue-recordings.ts does the I/O.
 */

/** One stretch of a context's recording: when it started (on the transcription's clock) and where it sits in the one WAV. */
export type RecordingPart = { startMs: number; offsetMs: number; durationMs: number };

/** A final transcript line as heard live, under its context's voice label. */
export type LiveLine = { label: string; text: string; startMs: number; endMs: number };
/** What the backend called a voice by the end of the conversation. */
export type VoiceName = { label: string; personId: string | null; name: string; confidence: string; confirmed: boolean };
/** One turn of transcript.json, as the backend's memory run reads it. */
export type TranscriptSegment = { speaker: string; personId: string | null; name: string | null; confidence: string; text: string; startMs: number; endMs: number };

/** Consecutive lines of one live voice, by index into the lines. */
export type LineRun = { label: string; lines: number[] };

/** Lines this far apart start a new run even under the same voice. */
export const LINE_RUN_GAP_MS = 20_000;
/** Longer lines are sampled from their start: plenty for a voice-print. */
export const MAX_LINE_SAMPLE_MS = 20_000;

/** Where a moment of the conversation sits in the recording, or null if it wasn't recorded. */
export function offsetOf(parts: RecordingPart[], wallMs: number): number | null {
  for (const part of parts) {
    if (wallMs >= part.startMs && wallMs <= part.startMs + part.durationMs) return part.offsetMs + (wallMs - part.startMs);
  }
  return null;
}

/** The lines as runs of one voice; unlabelled lines stand alone. */
export function lineRuns(lines: LiveLine[], gapMs = LINE_RUN_GAP_MS): LineRun[] {
  const runs: LineRun[] = [];
  lines.forEach((line, index) => {
    const last = runs[runs.length - 1];
    const previous = last ? lines[last.lines[last.lines.length - 1]] : null;
    if (last && line.label && last.label === line.label && previous && line.startMs - previous.endMs <= gapMs) last.lines.push(index);
    else runs.push({ label: line.label, lines: [index] });
  });
  return runs;
}

/** The recording ranges to voice-print for each line (null where the line wasn't recorded or has no length). */
export function lineRanges(lines: LiveLine[], parts: RecordingPart[]): ({ startMs: number; endMs: number } | null)[] {
  return lines.map((line) => {
    const start = offsetOf(parts, line.startMs);
    const end = offsetOf(parts, line.endMs);
    if (start === null || end === null || end <= start) return null;
    return { startMs: Math.round(start), endMs: Math.round(Math.min(end, start + MAX_LINE_SAMPLE_MS)) };
  });
}

/**
 * Names every line. embeddings holds one voice-print per line (null where
 * none); a run's lines are pooled into one. candidates are the people to
 * match against (with prints in store); names gives their display names.
 */
export function nameLines(
  lines: LiveLine[],
  embeddings: (ArrayLike<number> | null)[],
  store: PrintStore,
  candidates: string[],
  names: Map<string, string>,
  voices: VoiceName[],
): TranscriptSegment[] {
  const byLabel = new Map(voices.map((voice) => [voice.label, voice]));
  const out: TranscriptSegment[] = new Array(lines.length);
  for (const run of lineRuns(lines)) {
    const pooled = pool(run.lines.map((index) => embeddings[index]).filter((embedding): embedding is ArrayLike<number> => Boolean(embedding)));
    const identity = pooled ? identify(scoreCandidates(pooled, store, candidates)) : null;
    const voice = byLabel.get(run.label);
    let who: { personId: string | null; name: string | null; confidence: string };
    if (identity && identity.confidence !== "low") {
      who = { personId: identity.personId, name: names.get(identity.personId) ?? identity.personId, confidence: identity.confidence };
    } else if (voice?.name) {
      who = { personId: voice.personId, name: voice.name, confidence: voice.confirmed ? "medium" : "low" };
    } else {
      who = { personId: null, name: identity ? names.get(identity.personId) ?? null : null, confidence: "low" };
    }
    for (const index of run.lines) {
      const line = lines[index];
      out[index] = { speaker: line.label || "?", ...who, text: line.text, startMs: line.startMs, endMs: line.endMs };
    }
  }
  return out;
}

/** The live transcript with the live names only: the hand-off when there's no recording or no voice model. */
export function liveTranscript(lines: LiveLine[], voices: VoiceName[]): TranscriptSegment[] {
  return nameLines(lines, lines.map(() => null), {}, [], new Map(), voices);
}

/** The backend's HTTP address from its websocket one: ws://host:port/x → http://host:port. */
export function httpBase(wsUrl: string): string {
  const match = /^(wss?|https?):\/\/([^/?#]+)/i.exec(wsUrl.trim());
  if (!match) return "";
  const secure = /^(wss|https)$/i.test(match[1]);
  return `${secure ? "https" : "http"}://${match[2]}`;
}

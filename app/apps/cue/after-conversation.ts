import { PRINT_KNOWN, PRINT_UNCERTAIN, scoreCandidates, type PrintStore } from "./voiceprints";

/**
 * After a conversation: the recording's parts, Soniox's async transcript of
 * it, and naming its speakers from voice-print samples and the names given
 * live. Pure, so it runs under node tests; cue-after.ts does the I/O.
 */

/** One stretch of a context's recording: when it started and where it sits in the one WAV. */
export type RecordingPart = { startMs: number; offsetMs: number; durationMs: number };

/** A Soniox async token: times are offsets into the recording. */
export type AsyncToken = { text: string; start_ms?: number; end_ms?: number; speaker?: string | number };

/** A run of one async speaker's words: offsets into the recording, and the wall-clock times. */
export type AsyncSegment = { speaker: string; text: string; offsetStartMs: number; offsetEndMs: number; startMs: number; endMs: number };

/** A name given live: a voice's words between two times, and who it was said to be. */
export type LiveName = { startMs: number; endMs: number; personId: string | null; name: string; confirmed: boolean };

export type SpeakerName = { personId: string | null; name: string | null; confidence: "high" | "medium" | "low" };

/** The wall-clock time of an offset into a recording made of parts. */
export function wallTime(parts: RecordingPart[], offsetMs: number): number {
  const part = [...parts].reverse().find((candidate) => candidate.offsetMs <= offsetMs) ?? parts[0];
  return part ? part.startMs + (offsetMs - part.offsetMs) : offsetMs;
}

/** Soniox's tokens as runs of one speaker. */
export function tokensToSegments(tokens: AsyncToken[], parts: RecordingPart[]): AsyncSegment[] {
  const segments: AsyncSegment[] = [];
  for (const token of tokens) {
    if (!token.text || token.start_ms === undefined) continue;
    const speaker = String(token.speaker ?? "");
    const last = segments[segments.length - 1];
    const end = token.end_ms ?? token.start_ms;
    if (last && last.speaker === speaker) {
      last.text += token.text;
      last.offsetEndMs = end;
    } else if (token.text.trim()) {
      segments.push({ speaker, text: token.text, offsetStartMs: token.start_ms, offsetEndMs: end, startMs: 0, endMs: 0 });
    }
  }
  for (const segment of segments) {
    segment.text = segment.text.trim();
    segment.startMs = wallTime(parts, segment.offsetStartMs);
    segment.endMs = wallTime(parts, segment.offsetEndMs);
  }
  return segments;
}

/**
 * Where to voice-print an async speaker: up to `count` ranges of the
 * recording, from their longest turns spread across the conversation, each
 * MIN_SAMPLE_MS to MAX_SAMPLE_MS.
 */
export const MIN_SAMPLE_MS = 2_000;
export const MAX_SAMPLE_MS = 8_000;
export function sampleRanges(segments: AsyncSegment[], speaker: string, count = 5): { startMs: number; endMs: number }[] {
  const turns = segments
    .filter((segment) => segment.speaker === speaker && segment.offsetEndMs - segment.offsetStartMs >= MIN_SAMPLE_MS)
    .sort((a, b) => a.offsetStartMs - b.offsetStartMs);
  if (turns.length <= count) return turns.map(clip);
  // Spread: split the turns into `count` stretches in time order and take the longest of each.
  const picked = [];
  for (let i = 0; i < count; i++) {
    const group = turns.slice(Math.floor((i * turns.length) / count), Math.floor(((i + 1) * turns.length) / count));
    picked.push(group.reduce((a, b) => (b.offsetEndMs - b.offsetStartMs > a.offsetEndMs - a.offsetStartMs ? b : a)));
  }
  return picked.map(clip);
}

function clip(segment: AsyncSegment): { startMs: number; endMs: number } {
  const middle = (segment.offsetStartMs + segment.offsetEndMs) / 2;
  const half = Math.min(MAX_SAMPLE_MS, segment.offsetEndMs - segment.offsetStartMs) / 2;
  return { startMs: Math.round(middle - half), endMs: Math.round(middle + half) };
}

/**
 * Names one async speaker. Names given live (by overlap in time, confirmed
 * ones counting double) and voice-print samples (each sample's best match
 * above PRINT_UNCERTAIN) both vote. A confirmed live name the prints don't
 * contradict is high confidence; prints alone are high only when most
 * samples agree at PRINT_KNOWN or better. Disagreement is low.
 */
export function nameSpeaker(
  segments: AsyncSegment[],
  speaker: string,
  samples: (ArrayLike<number> | null)[],
  store: PrintStore,
  candidates: string[],
  live: LiveName[],
  names: Map<string, string>,
): SpeakerName {
  // Live names, weighted by how long they overlap this speaker's words.
  const liveVotes = new Map<string, { ms: number; personId: string | null; name: string; confirmed: boolean }>();
  let spoken = 0;
  for (const segment of segments.filter((candidate) => candidate.speaker === speaker)) {
    spoken += segment.endMs - segment.startMs;
    for (const named of live) {
      const overlap = Math.min(segment.endMs, named.endMs) - Math.max(segment.startMs, named.startMs);
      if (overlap <= 0) continue;
      const key = named.personId ?? named.name;
      const vote = liveVotes.get(key) ?? { ms: 0, personId: named.personId, name: named.name, confirmed: false };
      vote.ms += overlap * (named.confirmed ? 2 : 1);
      vote.confirmed ||= named.confirmed;
      liveVotes.set(key, vote);
    }
  }
  const liveTotal = [...liveVotes.values()].reduce((sum, vote) => sum + vote.ms, 0);
  const liveBest = [...liveVotes.values()].sort((a, b) => b.ms - a.ms)[0];
  const liveWinner = liveBest && liveBest.ms >= 0.6 * liveTotal && liveBest.ms >= Math.min(3000, spoken / 2) ? liveBest : null;

  // Voice-print samples.
  const printVotes = new Map<string, { votes: number; similarity: number }>();
  let sampled = 0;
  for (const sample of samples) {
    if (!sample) continue;
    sampled += 1;
    const best = scoreCandidates(sample, store, candidates)[0];
    if (!best || best.similarity < PRINT_UNCERTAIN) continue;
    const vote = printVotes.get(best.personId) ?? { votes: 0, similarity: 0 };
    vote.votes += 1;
    vote.similarity += best.similarity;
    printVotes.set(best.personId, vote);
  }
  const printBest = [...printVotes.entries()].sort((a, b) => b[1].votes - a[1].votes || b[1].similarity - a[1].similarity)[0];
  const print = printBest ? { personId: printBest[0], agreement: printBest[1].votes / Math.max(1, sampled), average: printBest[1].similarity / printBest[1].votes } : null;
  const nameOf = (personId: string | null, fallback: string | null) => (personId ? names.get(personId) ?? fallback ?? personId : fallback);

  if (liveWinner) {
    const contradicted = print && print.personId !== liveWinner.personId && print.average >= 0.6 && print.agreement >= 0.6;
    if (contradicted) return { personId: liveWinner.personId, name: nameOf(liveWinner.personId, liveWinner.name), confidence: "low" };
    const agrees = print?.personId === liveWinner.personId;
    return {
      personId: liveWinner.personId,
      name: nameOf(liveWinner.personId, liveWinner.name),
      confidence: liveWinner.confirmed ? "high" : agrees ? "medium" : "low",
    };
  }
  if (print && print.agreement >= 0.6) {
    const confidence = print.average >= PRINT_KNOWN ? "high" : print.average >= 0.65 ? "medium" : "low";
    return { personId: print.personId, name: nameOf(print.personId, null), confidence };
  }
  return { personId: null, name: print ? nameOf(print.personId, null) : null, confidence: "low" };
}

/** A multipart/form-data body with one file field (Soniox's Files API; NativeScript has no multipart). */
export function multipartBody(boundary: string, field: string, filename: string, contentType: string, data: Uint8Array): Uint8Array {
  const head = ascii(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = ascii(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + data.length + tail.length);
  body.set(head, 0);
  body.set(data, head.length);
  body.set(tail, head.length + data.length);
  return body;
}

/** Multipart headers are ASCII (the file name is ours). */
function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0) & 0x7f);
}

/** A final transcript line as heard live, under its context's voice label. */
export type LiveLine = { label: string; text: string; startMs: number; endMs: number };
/** What the backend called a voice by the end of the conversation. */
export type VoiceName = { label: string; personId: string | null; name: string; confidence: string; confirmed: boolean };
/** One turn of transcript.json, as the backend's memory run reads it. */
export type TranscriptSegment = { speaker: string; personId: string | null; name: string | null; confidence: string; text: string; startMs: number; endMs: number };

/** The live names, as stretches of time, for naming the async speakers. */
export function liveNames(lines: LiveLine[], voices: VoiceName[]): LiveName[] {
  const byLabel = new Map(voices.map((voice) => [voice.label, voice]));
  const out: LiveName[] = [];
  for (const line of lines) {
    const voice = byLabel.get(line.label);
    if (voice?.name) out.push({ startMs: line.startMs, endMs: line.endMs, personId: voice.personId, name: voice.name, confirmed: voice.confirmed });
  }
  return out;
}

/** The live transcript as transcript.json's segments: what's handed off when async re-transcription can't run. */
export function liveTranscript(lines: LiveLine[], voices: VoiceName[]): TranscriptSegment[] {
  const byLabel = new Map(voices.map((voice) => [voice.label, voice]));
  return lines.map((line) => {
    const voice = byLabel.get(line.label);
    return {
      speaker: line.label || "?",
      personId: voice?.personId ?? null,
      name: voice?.name || null,
      confidence: voice ? (voice.confirmed ? "high" : voice.confidence) : "low",
      text: line.text,
      startMs: line.startMs,
      endMs: line.endMs,
    };
  });
}

/** The backend's HTTP address from its websocket one: ws://host:port/x → http://host:port. */
export function httpBase(wsUrl: string): string {
  const match = /^(wss?|https?):\/\/([^/?#]+)/i.exec(wsUrl.trim());
  if (!match) return "";
  const secure = /^(wss|https)$/i.test(match[1]);
  return `${secure ? "https" : "http"}://${match[2]}`;
}

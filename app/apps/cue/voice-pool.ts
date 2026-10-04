/**
 * The audio behind each run of one voice: a ring of recent microphone
 * audio on the transcription's clock, and the run being spoken now, cut to
 * its words. Live transcription is good at noticing that the speaker
 * changed and poor at knowing who it changed to (it reuses its numbers,
 * and starts over when its stream restarts), so each run is voice-printed
 * on its own: when it ends, and at RUN_FIRST_MS, then every RUN_STEP_MS
 * more, up to RUN_MAX_MS, while it goes on. Pure, so it runs under node tests.
 */

const BYTES_PER_MS = 32; // 16 kHz, 16-bit mono
export const RING_KEEP_MS = 180_000;
/** Words' edges are fuzzy; keep only a segment's middle. */
export const TRIM_MS = 150;
export const MIN_SEGMENT_MS = 600;
/** A run shorter than this when it ends isn't worth a voice-print. */
export const RUN_MIN_MS = 1_500;
export const RUN_FIRST_MS = 8_000;
export const RUN_STEP_MS = 8_000;
export const RUN_MAX_MS = 30_000;
/** A pause this long ends a run even when the same voice goes on. */
export const RUN_GAP_MS = 20_000;
/** How close a chunk's arrival must be to a stream's origin to be its first chunk. */
const ORIGIN_MATCH_MS = 3;

type Chunk = { receivedMs: number; startMs: number; bytes: Uint8Array };

/**
 * Soniox times words as its stream's origin (the arrival time of the first
 * chunk it got) plus the audio counted since. The ring stamps chunks the
 * same way: each starts where the one before ended, and a stream's origin
 * (onAudioOrigin) re-stamps from its first chunk on, so slicing by a word's
 * times gets that word's audio even when the glasses drop packets.
 */
export class PcmRing {
  private chunks: Chunk[] = [];
  private pendingOrigin: number | null = null;

  constructor(private readonly keepMs = RING_KEEP_MS) {}

  /** A chunk as it arrives; returns where it starts on the transcription's clock. */
  push(bytes: Uint8Array, receivedMs: number): number {
    const last = this.chunks[this.chunks.length - 1];
    let startMs = last ? last.startMs + last.bytes.length / BYTES_PER_MS : receivedMs;
    if (this.pendingOrigin !== null && Math.abs(receivedMs - this.pendingOrigin) <= ORIGIN_MATCH_MS) {
      startMs = this.pendingOrigin;
      this.pendingOrigin = null;
    }
    this.chunks.push({ receivedMs, startMs, bytes });
    const cutoff = startMs - this.keepMs;
    while (this.chunks.length && this.chunks[0].startMs < cutoff) this.chunks.shift();
    return startMs;
  }

  /** A transcription stream's clock starts at the chunk that arrived at originMs (it may not have arrived yet). */
  anchor(originMs: number): void {
    let index = -1;
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      if (Math.abs(this.chunks[i].receivedMs - originMs) <= ORIGIN_MATCH_MS) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      this.pendingOrigin = originMs;
      return;
    }
    let at = originMs;
    for (let i = index; i < this.chunks.length; i++) {
      this.chunks[i].startMs = at;
      at += this.chunks[i].bytes.length / BYTES_PER_MS;
    }
    // Earlier chunks the new clock overlaps belonged to the old stream, whose words are in.
    const earlier = this.chunks.slice(0, index).filter((chunk) => chunk.startMs + chunk.bytes.length / BYTES_PER_MS <= originMs);
    this.chunks = [...earlier, ...this.chunks.slice(index)];
  }

  /** The audio between two times, as 16 kHz S16LE. */
  slice(startMs: number, endMs: number): Uint8Array {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.startMs + chunk.bytes.length / BYTES_PER_MS;
      if (chunkEnd <= startMs || chunk.startMs >= endMs) continue;
      const from = evenBytes(Math.max(0, (startMs - chunk.startMs) * BYTES_PER_MS));
      const to = evenBytes(Math.min(chunk.bytes.length, (endMs - chunk.startMs) * BYTES_PER_MS));
      if (to <= from) continue;
      parts.push(chunk.bytes.subarray(from, to));
      total += to - from;
    }
    return concat(parts, total);
  }

  clear(): void {
    this.chunks = [];
    this.pendingOrigin = null;
  }
}

/** A run: one live voice label's consecutive words. */
export type Run = { label: string; startMs: number; endMs: number };
/** A run's pooled audio, due for a voice-print. */
export type RunAudio = { run: Run; pcm: Uint8Array; seconds: number };

type OpenRun = Run & { parts: Uint8Array[]; bytes: number; nextBytes: number; embeddedBytes: number };

export class RunPools {
  private open: OpenRun | null = null;

  /**
   * Adds one final segment (its label and times, as the transcript has
   * them); returns what's due for a voice-print: the run this segment ended,
   * and this run when it has reached its next step.
   */
  add(label: string, ring: PcmRing, startMs: number, endMs: number): RunAudio[] {
    const due: RunAudio[] = [];
    if (this.open && (this.open.label !== label || startMs - this.open.endMs > RUN_GAP_MS)) {
      const closed = this.close();
      if (closed) due.push(closed);
    }
    if (!this.open) this.open = { label, startMs, endMs, parts: [], bytes: 0, nextBytes: RUN_FIRST_MS * BYTES_PER_MS, embeddedBytes: 0 };
    const run = this.open;
    run.endMs = Math.max(run.endMs, endMs);
    if (endMs - startMs >= MIN_SEGMENT_MS) {
      const audio = ring.slice(startMs + TRIM_MS, endMs - TRIM_MS);
      if (audio.length) {
        run.parts.push(audio);
        run.bytes += audio.length;
        // Keep the latest RUN_MAX_MS: the voice as it sounds now.
        while (run.parts.length > 1 && run.bytes > RUN_MAX_MS * BYTES_PER_MS) run.bytes -= run.parts.shift()!.length;
      }
    }
    if (run.bytes >= run.nextBytes && run.nextBytes <= RUN_MAX_MS * BYTES_PER_MS) {
      run.nextBytes += RUN_STEP_MS * BYTES_PER_MS;
      due.push(this.audio(run));
    }
    return due;
  }

  /** Ends the open run (a pause, a switch); returns it if it has new audio worth a voice-print. */
  close(): RunAudio | null {
    const run = this.open;
    this.open = null;
    if (!run || run.bytes < RUN_MIN_MS * BYTES_PER_MS) return null;
    // Already printed at its last step and barely longer since: nothing new.
    if (run.embeddedBytes && run.bytes - run.embeddedBytes < 2_000 * BYTES_PER_MS) return null;
    return this.audio(run);
  }

  private audio(run: OpenRun): RunAudio {
    run.embeddedBytes = run.bytes;
    return { run: { label: run.label, startMs: run.startMs, endMs: run.endMs }, pcm: concat(run.parts, run.bytes), seconds: run.bytes / BYTES_PER_MS / 1000 };
  }
}

function evenBytes(value: number): number {
  return Math.floor(value / 2) * 2;
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

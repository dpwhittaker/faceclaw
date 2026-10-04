/**
 * The audio behind each live voice: a ring of recent microphone audio on
 * the transcription's own clock, and per-voice pools of that audio cut to
 * each voice's words. A pool asks to be embedded once it holds
 * POOL_FIRST_MS, then every POOL_STEP_MS more, up to POOL_MAX_MS. Pure, so
 * it runs under node tests.
 */

const BYTES_PER_MS = 32; // 16 kHz, 16-bit mono
export const RING_KEEP_MS = 180_000;
/** Words' edges are fuzzy; keep only a segment's middle. */
export const TRIM_MS = 150;
export const MIN_SEGMENT_MS = 600;
export const POOL_FIRST_MS = 8_000;
export const POOL_STEP_MS = 8_000;
export const POOL_MAX_MS = 30_000;
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

type Pool = { parts: Uint8Array[]; bytes: number; nextBytes: number };

export class VoicePools {
  private readonly pools = new Map<string, Pool>();

  /**
   * Adds one segment of a voice's speech (its start and end, as the
   * transcript times it); returns the pooled audio when it's time to embed.
   */
  add(voice: string, ring: PcmRing, startMs: number, endMs: number): { pcm: Uint8Array; seconds: number } | null {
    if (endMs - startMs < MIN_SEGMENT_MS) return null;
    const audio = ring.slice(startMs + TRIM_MS, endMs - TRIM_MS);
    if (!audio.length) return null;
    let pool = this.pools.get(voice);
    if (!pool) this.pools.set(voice, (pool = { parts: [], bytes: 0, nextBytes: POOL_FIRST_MS * BYTES_PER_MS }));
    pool.parts.push(audio);
    pool.bytes += audio.length;
    // Keep the latest POOL_MAX_MS: the voice as it sounds now.
    while (pool.parts.length > 1 && pool.bytes > POOL_MAX_MS * BYTES_PER_MS) pool.bytes -= pool.parts.shift()!.length;
    if (pool.bytes < pool.nextBytes || pool.nextBytes > POOL_MAX_MS * BYTES_PER_MS) return null;
    pool.nextBytes += POOL_STEP_MS * BYTES_PER_MS;
    return this.pooled(voice);
  }

  /** A voice's pooled audio now (for training a print once it's named). */
  pooled(voice: string): { pcm: Uint8Array; seconds: number } | null {
    const pool = this.pools.get(voice);
    if (!pool || !pool.bytes) return null;
    return { pcm: concat(pool.parts, pool.bytes), seconds: pool.bytes / BYTES_PER_MS / 1000 };
  }

  clear(): void {
    this.pools.clear();
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

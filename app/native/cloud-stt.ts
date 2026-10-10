import type { SpeakerSegment } from "./transcript-format";

/**
 * Shared shape for the cloud speech-to-text providers (ElevenLabs, Whisper,
 * Soniox).
 * The voice bridge holds one of these while a cloud provider owns the
 * transcript; the Java controller then only decodes LC3 to PCM and hands it
 * over via acceptPcm.
 */

export type CloudSttTranscriptEvent = {
  text: string;
  isFinal: boolean;
  /** Optional presentation for Transcribe only; dictation uses plain text. */
  transcribeText?: string;
  paragraphBreakAfter?: boolean;
  /**
   * The same words split into runs of one speaker, from providers that
   * diarize (Soniox). Covers exactly this event's text: on a partial, the
   * words so far including unconfirmed ones.
   */
  segments?: SpeakerSegment[];
  /**
   * Words that just became final, cut at sentence ends, each delivered once
   * (Soniox): a sentence as soon as its last word is confirmed, rather than
   * at the pause that ends the utterance, and on the final event whatever
   * was left. Cue sends these to its backend.
   */
  sentences?: SpeakerSegment[];
};

export type CloudSttOptions = {
  apiKey: string;
  onTranscript: (event: CloudSttTranscriptEvent) => void;
  onStatus: (status: string) => void;
  onError: (message: string) => void;
  onReady?: () => void;
  onDisconnected?: (message: string) => void;
  /**
   * The provider's clock for a stream started: its word times count audio
   * from the chunk captured at originMs (Soniox only).
   */
  onAudioOrigin?: (stream: number, originMs: number) => void;
};

export interface CloudSttClient {
  /** Open whatever the provider needs before audio arrives. */
  start(): void;
  /**
   * Feed PCM (16 kHz signed-16-bit LE). capturedAtMs (epoch ms, default now)
   * is when the chunk was recorded, which differs from now for audio buffered
   * across a reconnect; segment times are anchored to it.
   */
  acceptPcm(pcm: Uint8Array, capturedAtMs?: number): void;
  /** End of utterance: produce a final transcript. */
  finish(): void;
  /** Commit a pause boundary while keeping the audio session open. */
  commitSegment?(): void;
  /** Abandon the session without finalizing. */
  stop(): void;
}

/** Sample rate of the PCM the G2 mic path produces, shared by all providers. */
export const CLOUD_STT_SAMPLE_RATE = 16000;

declare const android: any;

/** Copy a Uint8Array into a Java byte[] (for binary WebSocket frames etc.). */
export function toJavaBytes(bytes: Uint8Array): any {
  const javaBytes = Array.create("byte", bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i]!;
    javaBytes[i] = value > 127 ? value - 256 : value;
  }
  return javaBytes;
}

/** Base64 for audio payloads, via the Android SDK (no JS base64 in NS core). */
export function encodeBase64(bytes: Uint8Array): string {
  if (!global.isAndroid) return "";
  return String(android.util.Base64.encodeToString(toJavaBytes(bytes), android.util.Base64.NO_WRAP));
}

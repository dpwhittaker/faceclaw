import { appFilesDirPath, readTextFile, writeBinaryFile } from "../../native/file-access";
import { micModelPath, startMicModelDownload } from "../microphones/mic-models";
import { speakerRegistry } from "../microphones/speakers";
import type { CueCandidate, CueSpeaker, CueVoiceScore } from "./cue-channel";
import { PcmRing, VoicePools } from "./voice-pool";
import { normalize, printKindFor, scoreCandidates, trainPrint, type PrintKind, type PrintStore } from "./voiceprints";

declare const com: any;

/** The wearer's personId, as the backend names them. */
export const YOU = "you";
const MODEL = "speaker-embedding";
const SCORES_SENT = 5;

export type VoiceprintSink = (contextId: string, label: string, seconds: number, scores: CueVoiceScore[]) => void;

/**
 * Cue's live voice-prints. Microphone audio goes into a ring on the
 * transcription's clock; each final segment adds its voice's words to that
 * voice's pool; a pool that's due is embedded on FaceclawCueAudio's worker
 * and scored against the context's candidates and the wearer, and the
 * scores go to the backend, which names the voice. A confirmed name trains
 * that person's print with the voice's latest embedding. Prints never leave
 * the phone.
 */
export class CueVoices {
  private readonly ring = new PcmRing();
  private readonly pools = new Map<string, VoicePools>();
  private readonly latest = new Map<string, number[]>();
  private readonly candidates = new Map<string, CueCandidate[]>();
  private readonly kinds = new Map<string, PrintKind>();
  private readonly speakers = new Map<string, CueSpeaker>();
  // The person each voice's latest embedding already trained, so a repeated confirmation counts it once.
  private readonly trained = new Map<string, string>();
  private prints: PrintStore | null = null;

  constructor(private readonly send: VoiceprintSink) {}

  /** A microphone chunk as it arrives; returns where it starts on the transcription's clock. */
  push(bytes: Uint8Array, receivedMs: number): number {
    return this.ring.push(bytes, receivedMs);
  }

  /** A transcription stream's clock started (voiceControlBridge.onAudioOrigin). */
  anchor(originMs: number): void {
    this.ring.anchor(originMs);
  }

  /** Recent audio from the ring (the recorder's backfill). */
  slice(startMs: number, endMs: number): Uint8Array {
    return this.ring.slice(startMs, endMs);
  }

  /** A context began: whether it's a call (its voices sound like laptop speakers) or in the room. */
  beginContext(contextId: string, location: string | undefined): void {
    this.kinds.set(contextId, printKindFor(location));
  }

  setCandidates(contextId: string, candidates: CueCandidate[]): void {
    this.candidates.set(contextId, candidates);
  }

  candidatesFor(contextId: string): CueCandidate[] {
    return this.candidates.get(contextId) ?? [];
  }

  kindFor(contextId: string): PrintKind {
    return this.kinds.get(contextId) ?? "room";
  }

  /** The backend's name for a voice, if it has one. */
  speaker(contextId: string, label: string): CueSpeaker | null {
    return this.speakers.get(key(contextId, label)) ?? null;
  }

  /** Every name the backend gave in a context. */
  speakersIn(contextId: string): CueSpeaker[] {
    return [...this.speakers.values()].filter((speaker) => speaker.contextId === contextId);
  }

  /** A final segment of one voice's words. */
  heard(contextId: string, label: string, startMs: number, endMs: number): void {
    if (!label) return;
    let pools = this.pools.get(contextId);
    if (!pools) this.pools.set(contextId, (pools = new VoicePools()));
    const due = pools.add(label, this.ring, startMs, endMs);
    if (!due) return;
    embedPcm(due.pcm, (embedding) => {
      if (!embedding || !this.kinds.has(contextId)) return;
      const voice = key(contextId, label);
      this.latest.set(voice, embedding);
      this.trained.delete(voice);
      this.send(contextId, label, due.seconds, this.score(contextId, embedding));
      // A voice already named learns from its new audio too.
      const speaker = this.speakers.get(voice);
      if (speaker?.confirmed && speaker.personId) this.train(contextId, label, speaker.personId);
    });
  }

  /** The backend named a voice; a confirmed name trains that person's print. */
  named(speaker: CueSpeaker): void {
    this.speakers.set(key(speaker.contextId, speaker.speaker), speaker);
    if (speaker.confirmed && speaker.personId) this.train(speaker.contextId, speaker.speaker, speaker.personId);
  }

  /** A context ended: its pools and names go (the recording keeps the names it needs). */
  endContext(contextId: string): void {
    this.pools.delete(contextId);
    this.candidates.delete(contextId);
    this.kinds.delete(contextId);
    for (const map of [this.latest, this.speakers, this.trained] as Map<string, unknown>[]) {
      for (const voice of [...map.keys()]) if (voice.startsWith(`${contextId}\n`)) map.delete(voice);
    }
  }

  /** The prints, loaded on first use; the wearer's starts from Microphones' enrolled voice. */
  store(): PrintStore {
    if (this.prints) return this.prints;
    let prints: PrintStore = {};
    try {
      prints = JSON.parse(readTextFile(printsPath()) ?? "{}") as PrintStore;
    } catch (error) {
      console.warn(`[Cue] voice-prints unreadable, starting over: ${String(error)}`);
    }
    if (!prints[YOU]) {
      const wearer = speakerRegistry.wearer()?.embedding;
      if (wearer) prints[YOU] = { room: { embedding: normalize(wearer), count: 1 } };
    }
    this.prints = prints;
    return prints;
  }

  private score(contextId: string, embedding: number[]): CueVoiceScore[] {
    const ids = [YOU, ...this.candidatesFor(contextId).map((candidate) => candidate.personId)];
    return scoreCandidates(embedding, this.store(), ids)
      .slice(0, SCORES_SENT)
      .map((score) => ({ personId: score.personId, similarity: Math.round(score.similarity * 100) / 100 }));
  }

  private train(contextId: string, label: string, personId: string): void {
    const voice = key(contextId, label);
    const embedding = this.latest.get(voice);
    if (!embedding || this.trained.get(voice) === personId) return;
    const prints = this.store();
    prints[personId] = trainPrint(prints[personId], embedding, this.kindFor(contextId));
    this.trained.set(voice, personId);
    savePrints(prints);
    console.log(`[Cue] trained ${personId}'s ${this.kindFor(contextId)} voice-print from ${label}`);
  }
}

function key(contextId: string, label: string): string {
  return `${contextId}\n${label}`;
}

function printsPath(): string {
  return `${appFilesDirPath()}/cue/voiceprints.json`;
}

function savePrints(prints: PrintStore): void {
  const text = JSON.stringify(prints);
  writeBinaryFile(printsPath(), Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff));
}

/** The speaker-embedding model's path; starts its download (29 MB, once) when it isn't on the phone. */
export function voiceModelPath(): string | null {
  const path = micModelPath(MODEL);
  if (!path) startMicModelDownload(MODEL);
  return path;
}

/** Embeds pooled 16 kHz S16LE speech off the main thread; null without the model or with too little audio. */
export function embedPcm(pcm: Uint8Array, done: (embedding: number[] | null) => void): void {
  const path = voiceModelPath();
  if (!path) return done(null);
  // An ArrayBuffer marshals to a ByteBuffer, which the Java side copies at once.
  const buffer = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
  com.faceclaw.app.FaceclawCueAudio.embed(path, "", buffer, new com.faceclaw.app.FaceclawCueAudio.Listener({
    onEmbedding: (_id: string, embedding: any) => done(embedding ? floats(embedding) : null),
  }));
}

/** Embeds [start, end) ranges (ms into the file) of a recorded WAV; one entry per range, null where it failed. */
export function embedRanges(wavPath: string, ranges: { startMs: number; endMs: number }[], done: (embeddings: (number[] | null)[]) => void): void {
  const path = voiceModelPath();
  if (!path || !ranges.length) return done(ranges.map(() => null));
  const starts = Array.create("long", ranges.length);
  const ends = Array.create("long", ranges.length);
  ranges.forEach((range, index) => {
    starts[index] = range.startMs;
    ends[index] = range.endMs;
  });
  com.faceclaw.app.FaceclawCueAudio.embedRanges(path, "", wavPath, starts, ends, new com.faceclaw.app.FaceclawCueAudio.RangesListener({
    onEmbeddings: (_id: string, embeddings: any) => {
      const out: (number[] | null)[] = [];
      for (let i = 0; i < ranges.length; i++) out.push(embeddings?.[i] ? floats(embeddings[i]) : null);
      done(out);
    },
  }));
}

function floats(array: any): number[] {
  const out: number[] = [];
  for (let i = 0; i < array.length; i++) out.push(Number(array[i]));
  return out;
}

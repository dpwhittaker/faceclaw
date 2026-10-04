import { toJavaBytes } from "../../native/cloud-stt";
import { appFilesDirPath, deletePathRecursively, listDirectory, statPath, writeBinaryFile } from "../../native/file-access";
import { sonioxCreate, sonioxDelete, sonioxStatus, sonioxTranscript, sonioxUpload, uploadFile } from "../../native/soniox-async";
import { sonioxApiKeySetting } from "../../ui/dashboard-settings";
import { fetchWithUserAgent } from "../../util/http";
import {
  httpBase,
  liveNames,
  liveTranscript,
  nameSpeaker,
  sampleRanges,
  tokensToSegments,
  type LiveLine,
  type RecordingPart,
  type AsyncSegment,
  type TranscriptSegment,
  type VoiceName,
} from "./after-conversation";
import type { CueCandidate } from "./cue-channel";
import { cueBackendTokenSetting, cueBackendUrlSetting } from "./cue-settings";
import { YOU, embedRanges } from "./cue-voices";
import type { PrintStore } from "./voiceprints";

declare const com: any;
declare const java: any;

/**
 * Each context's recording, and what happens to it after the conversation.
 * One WAV per context, kept open while it's paused (a resume adds a part);
 * when it ends: AAC for keeping, Soniox's async re-transcription with
 * speaker labels, the speakers named from voice-print samples and the
 * names given live, then the hand-off to the backend (audio.m4a and
 * transcript.json, then POST done), which updates the notebooks. Each step
 * is saved in the context's meta.json, so a failure or a restart picks up
 * where it stopped; the folder goes once the backend has it.
 */

const SAMPLE_RATE = 16000;
const BYTES_PER_MS = 32;
const AAC_BITRATE = 32_000;
/** Speech before the first words that started a context. */
export const BACKFILL_MS = 15_000;
/** Shorter conversations aren't worth keeping. */
const MIN_KEEP_MS = 5_000;
const POLL_MS = 10_000;
/** A transcription still running after this is checked again on the next try. */
const POLL_LIMIT_MS = 30 * 60_000;
const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** After this many failed tries at Soniox, the live transcript goes instead. */
const ASYNC_TRIES = 4;
const SAMPLES_PER_SPEAKER = 5;

type Stage = "recording" | "ended" | "transcoded" | "transcribing" | "transcribed" | "named";

/** What the recorder knows about a context when it starts. */
export type RecordingContext = { id: string; title: string; kind: string; org: string; location: string; startedMs: number };

type Meta = RecordingContext & {
  endedMs: number;
  parts: RecordingPart[];
  lines: LiveLine[];
  voices: VoiceName[];
  candidates: CueCandidate[];
  stage: Stage;
  tries: number;
  asyncTries: number;
  nextTryMs: number;
  error: string;
  sonioxFileId: string;
  sonioxTranscriptionId: string;
};

type Open = { meta: Meta; recorder: any; bytes: number; part: RecordingPart | null };

export type RecordingsStatus = { pending: number; detail: string };

export class CueRecordings {
  private readonly open = new Map<string, Open>();
  private current: Open | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private working = false;
  // Asked to run while a pass was under way: run again after it.
  private again = false;
  // The next pass ignores retry times (the backend just came back).
  private force = false;
  private detail = "";
  private readonly listeners = new Set<(status: RecordingsStatus) => void>();
  private recordedUntil = 0;
  // Finished recordings not yet handed off, as of the last pass.
  private pending = 0;

  /** prints: the phone's voice-prints, for naming the async speakers. */
  constructor(private readonly prints: () => PrintStore) {}

  /**
   * A context became current: a new recording (with backfill, the speech
   * just before it started) or the next part of a paused one.
   */
  begin(context: RecordingContext, backfill: { pcm: Uint8Array; startMs: number } | null): void {
    let open = this.open.get(context.id);
    if (!open) {
      const meta: Meta = {
        ...context, endedMs: 0, parts: [], lines: [], voices: [], candidates: [], stage: "recording",
        tries: 0, asyncTries: 0, nextTryMs: 0, error: "", sonioxFileId: "", sonioxTranscriptionId: "",
      };
      try {
        open = { meta, recorder: new com.faceclaw.app.FaceclawWavRecorder(wavPath(context.id), SAMPLE_RATE, 1), bytes: 0, part: null };
      } catch (error) {
        console.warn(`[Cue] can't record ${context.id}: ${String(error)}`);
        return;
      }
      this.open.set(context.id, open);
      save(meta);
    }
    this.current = open;
    open.part = null;
    if (backfill?.pcm.length) this.append(backfill.pcm, backfill.startMs);
  }

  /** Where the last audio any recording took ends: a new one's backfill starts no earlier. */
  get recordedUntilMs(): number {
    return this.recordedUntil;
  }

  /** The current context paused (or there's none now): audio stops going to it. */
  pause(): void {
    if (this.current) save(this.current.meta);
    this.current = null;
  }

  /** A microphone chunk, stamped on the transcription's clock. */
  append(bytes: Uint8Array, startMs: number): void {
    const open = this.current;
    if (!open || !bytes.length) return;
    if (!open.part) {
      open.part = { startMs, offsetMs: open.bytes / BYTES_PER_MS, durationMs: 0 };
      open.meta.parts.push(open.part);
    }
    try {
      open.recorder.append(toJavaBytes(bytes));
    } catch (error) {
      console.warn(`[Cue] recording write failed: ${String(error)}`);
      return;
    }
    open.bytes += bytes.length;
    open.part.durationMs += bytes.length / BYTES_PER_MS;
    this.recordedUntil = Math.max(this.recordedUntil, startMs + bytes.length / BYTES_PER_MS);
  }

  /** A final transcript line of a context. */
  line(contextId: string, line: LiveLine): void {
    this.open.get(contextId)?.meta.lines.push(line);
  }

  /** A context ended: finish its WAV and start the after-conversation steps. */
  end(contextId: string, endedMs: number, voices: VoiceName[], candidates: CueCandidate[]): void {
    const open = this.open.get(contextId);
    if (!open) return;
    this.open.delete(contextId);
    if (this.current === open) this.current = null;
    try {
      open.recorder.finish();
    } catch (error) {
      console.warn(`[Cue] recording finish failed: ${String(error)}`);
    }
    Object.assign(open.meta, { endedMs, voices, candidates, stage: "ended" as Stage, nextTryMs: 0 });
    save(open.meta);
    this.schedule(0);
  }

  /** Picks up recordings left from before (finished or not) and hands them off. */
  resume(): void {
    for (const meta of allMetas()) {
      if (meta.stage !== "recording" || this.open.has(meta.id)) continue;
      // The app stopped mid-conversation: the WAV's header never got its length.
      const ms = Number(com.faceclaw.app.FaceclawCueAudio.repairWav(wavPath(meta.id)));
      console.log(`[Cue] recording ${meta.id} was cut off at ${Math.round(ms / 1000)} s; handing off what there is`);
      Object.assign(meta, { stage: "ended" as Stage, endedMs: meta.endedMs || lastPartEnd(meta), nextTryMs: 0 });
      save(meta);
    }
    this.schedule(0);
  }

  /** Tries every waiting recording now, whatever its retry time (the backend just came back). */
  retryNow(): void {
    if (!this.pending) return;
    this.force = true;
    this.schedule(0);
  }

  onStatus(listener: (status: RecordingsStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  /** Cheap enough to paint with: counted on each pass over the recordings. */
  status(): RecordingsStatus {
    return { pending: this.pending, detail: this.detail };
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.work();
    }, Math.max(0, delayMs));
  }

  /** Runs every due recording through its next steps, one at a time. */
  private async work(): Promise<void> {
    if (this.working) {
      this.again = true;
      return;
    }
    this.working = true;
    const force = this.force;
    this.force = false;
    let nextMs = Infinity;
    try {
      const metas = allMetas().filter((meta) => meta.stage !== "recording");
      this.pending = metas.length;
      for (const meta of metas) {
        if (meta.nextTryMs > Date.now() && !force) {
          nextMs = Math.min(nextMs, meta.nextTryMs);
          continue;
        }
        try {
          await this.advance(meta);
        } catch (error) {
          meta.tries += 1;
          meta.error = String((error as Error)?.message ?? error);
          meta.nextTryMs = Date.now() + RETRY_MS[Math.min(meta.tries - 1, RETRY_MS.length - 1)];
          if (meta.stage === "transcribing" || meta.stage === "transcoded") meta.asyncTries += 1;
          save(meta);
          nextMs = Math.min(nextMs, meta.nextTryMs);
          this.setDetail(`Couldn't hand off "${meta.title}": ${meta.error}`);
          console.warn(`[Cue] ${meta.id} (${meta.stage}): ${meta.error}`);
        }
      }
    } finally {
      this.working = false;
    }
    if (this.again) {
      this.again = false;
      this.schedule(0);
    } else if (Number.isFinite(nextMs)) {
      this.schedule(nextMs - Date.now());
    }
  }

  /** One recording through as many steps as it can go now. */
  private async advance(meta: Meta): Promise<void> {
    if (meta.stage === "ended") {
      const audioMs = meta.parts.reduce((sum, part) => sum + part.durationMs, 0);
      if (audioMs < MIN_KEEP_MS || !meta.lines.some((line) => line.text.trim())) {
        console.log(`[Cue] ${meta.id}: nothing worth keeping (${Math.round(audioMs / 1000)} s)`);
        deletePathRecursively(dirPath(meta.id));
        this.pending = Math.max(0, this.pending - 1);
        this.emit();
        return;
      }
      this.setDetail(`Saving "${meta.title}"...`);
      await transcode(wavPath(meta.id), m4aPath(meta.id));
      this.next(meta, "transcoded");
    }
    if (meta.stage === "transcoded" || meta.stage === "transcribing") {
      const apiKey = sonioxApiKeySetting.get().trim();
      if (!apiKey || meta.asyncTries >= ASYNC_TRIES) {
        // No async re-transcription: hand off what was heard live.
        if (apiKey && (meta.sonioxFileId || meta.sonioxTranscriptionId)) {
          await sonioxDelete(apiKey, meta.sonioxTranscriptionId, meta.sonioxFileId).catch(() => {});
        }
        writeJson(transcriptPath(meta.id), { source: "live", segments: liveTranscript(meta.lines, meta.voices) });
        this.next(meta, "named");
      } else {
        this.setDetail(`Transcribing "${meta.title}"...`);
        await this.transcribe(meta, apiKey);
      }
    }
    if (meta.stage === "transcribed") {
      this.setDetail(`Naming the speakers in "${meta.title}"...`);
      await this.nameSpeakers(meta);
      this.next(meta, "named");
    }
    if (meta.stage === "named") {
      this.setDetail(`Handing "${meta.title}" to Cue's backend...`);
      await handOff(meta);
      deletePathRecursively(dirPath(meta.id));
      this.pending = Math.max(0, this.pending - 1);
      this.setDetail("");
      console.log(`[Cue] ${meta.id}: handed off`);
    }
  }

  private async transcribe(meta: Meta, apiKey: string): Promise<void> {
    if (!meta.sonioxFileId) {
      meta.sonioxFileId = await sonioxUpload(apiKey, m4aPath(meta.id), "audio/mp4");
      save(meta);
    }
    if (!meta.sonioxTranscriptionId) {
      meta.sonioxTranscriptionId = await sonioxCreate(apiKey, meta.sonioxFileId);
      this.next(meta, "transcribing");
    }
    const deadline = Date.now() + POLL_LIMIT_MS;
    for (;;) {
      const status = await sonioxStatus(apiKey, meta.sonioxTranscriptionId);
      if (status.status === "completed") break;
      if (status.status === "error") {
        // Start over next time with a fresh transcription of the same file.
        await sonioxDelete(apiKey, meta.sonioxTranscriptionId, "").catch(() => {});
        meta.sonioxTranscriptionId = "";
        throw new Error(`Soniox couldn't transcribe it: ${status.error}`);
      }
      if (Date.now() > deadline) throw new Error("Soniox is still transcribing; checking again later");
      await sleep(POLL_MS);
    }
    // Kept as speaker turns: a long meeting's tokens run to megabytes.
    const tokens = await sonioxTranscript(apiKey, meta.sonioxTranscriptionId);
    writeJson(asyncPath(meta.id), tokensToSegments(tokens, meta.parts));
    try {
      await sonioxDelete(apiKey, meta.sonioxTranscriptionId, meta.sonioxFileId);
    } catch (error) {
      console.warn(`[Cue] Soniox cleanup for ${meta.id}: ${String(error)}`);
    }
    meta.sonioxFileId = meta.sonioxTranscriptionId = "";
    this.next(meta, "transcribed");
  }

  /** Names each async speaker from voice-print samples of the WAV and the names given live. */
  private async nameSpeakers(meta: Meta): Promise<void> {
    const segments = (readJson(asyncPath(meta.id)) ?? []) as AsyncSegment[];
    const store = this.prints();
    const names = new Map<string, string>([[YOU, "You"]]);
    for (const candidate of meta.candidates) names.set(candidate.personId, candidate.name);
    for (const voice of meta.voices) if (voice.personId) names.set(voice.personId, voice.name);
    const candidates = [...names.keys()];
    const live = liveNames(meta.lines, meta.voices);
    const named = new Map<string, ReturnType<typeof nameSpeaker>>();
    for (const speaker of new Set(segments.map((segment) => segment.speaker))) {
      const ranges = sampleRanges(segments, speaker, SAMPLES_PER_SPEAKER);
      const samples = await new Promise<(number[] | null)[]>((resolve) => embedRanges(wavPath(meta.id), ranges, resolve));
      named.set(speaker, nameSpeaker(segments, speaker, samples, store, candidates, live, names));
      console.log(`[Cue] ${meta.id}: speaker ${speaker} → ${named.get(speaker)?.name ?? "?"} (${named.get(speaker)?.confidence})`);
    }
    const transcript: TranscriptSegment[] = segments.map((segment) => {
      const name = named.get(segment.speaker);
      return { speaker: segment.speaker, personId: name?.personId ?? null, name: name?.name ?? null, confidence: name?.confidence ?? "low", text: segment.text, startMs: segment.startMs, endMs: segment.endMs };
    });
    writeJson(transcriptPath(meta.id), { source: "soniox-async", segments: transcript });
    deletePathRecursively(wavPath(meta.id));
  }

  private next(meta: Meta, stage: Stage): void {
    meta.stage = stage;
    meta.tries = 0;
    meta.error = "";
    save(meta);
    this.emit();
  }

  private setDetail(detail: string): void {
    this.detail = detail;
    this.emit();
  }

  private emit(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }
}

/** PUT audio.m4a and transcript.json, then POST done; a backend that lost the context gets context.json too. */
async function handOff(meta: Meta): Promise<void> {
  const base = httpBase(cueBackendUrlSetting.get());
  const token = cueBackendTokenSetting.get();
  if (!base || !token) throw new Error("Cue's backend isn't set up");
  const auth = `Bearer ${token}`;
  const url = (file: string) => `${base}/cue/recordings/${encodeURIComponent(meta.id)}/${file}`;
  const put = async (file: string, path: string, contentType: string) => {
    const result = await uploadFile("PUT", url(file), auth, path, contentType);
    if (result.status >= 300) throw new Error(`backend took ${file} with HTTP ${result.status}`);
  };
  if (statPath(m4aPath(meta.id))) await put("audio.m4a", m4aPath(meta.id), "audio/mp4");
  await put("transcript.json", transcriptPath(meta.id), "application/json");
  let done = await fetchWithUserAgent(url("done"), { method: "POST", headers: { Authorization: auth } });
  if (done.status === 409) {
    // The backend restarted mid-conversation and never wrote its context.json.
    writeJson(contextPath(meta.id), {
      id: meta.id, kind: meta.kind, title: meta.title, org: meta.org, teams: [], startedMs: meta.startedMs, endedMs: meta.endedMs, location: meta.location,
      personIds: [...new Set(meta.voices.filter((voice) => voice.personId && voice.personId !== YOU && voice.confirmed).map((voice) => voice.personId as string))],
    });
    await put("context.json", contextPath(meta.id), "application/json");
    done = await fetchWithUserAgent(url("done"), { method: "POST", headers: { Authorization: auth } });
  }
  if (!done.ok) throw new Error(`backend said ${done.status} to done`);
}

function transcode(wav: string, m4a: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Keep the WAV: naming the speakers reads samples from it.
    const transcoder = new com.faceclaw.app.FaceclawAudioTranscoder(wav, m4a, AAC_BITRATE, false, new com.faceclaw.app.FaceclawAudioTranscoder.Listener({
      onDone: () => setTimeout(resolve, 0),
      onError: (message: string) => setTimeout(() => reject(new Error(`couldn't encode the recording: ${message}`)), 0),
    }));
    transcoder.start();
  });
}

function lastPartEnd(meta: Meta): number {
  const last = meta.parts[meta.parts.length - 1];
  return last ? last.startMs + last.durationMs : meta.startedMs;
}

function rootPath(): string {
  return `${appFilesDirPath()}/cue/recordings`;
}
function dirName(contextId: string): string {
  return contextId.replace(/[^A-Za-z0-9_.-]/g, "_");
}
function dirPath(contextId: string): string {
  return `${rootPath()}/${dirName(contextId)}`;
}
const wavPath = (id: string) => `${dirPath(id)}/audio.wav`;
const m4aPath = (id: string) => `${dirPath(id)}/audio.m4a`;
const asyncPath = (id: string) => `${dirPath(id)}/soniox.json`;
const transcriptPath = (id: string) => `${dirPath(id)}/transcript.json`;
const contextPath = (id: string) => `${dirPath(id)}/context.json`;
const metaPath = (id: string) => `${dirPath(id)}/meta.json`;

function allMetas(): Meta[] {
  const metas: Meta[] = [];
  for (const entry of listDirectory(rootPath()) ?? []) {
    try {
      const meta = readJson(`${rootPath()}/${entry.name}/meta.json`) as Meta | null;
      if (meta) metas.push(meta);
    } catch {
      console.warn(`[Cue] unreadable recording meta in ${entry.name}`);
    }
  }
  return metas.sort((a, b) => a.startedMs - b.startedMs);
}

function save(meta: Meta): void {
  writeJson(metaPath(meta.id), meta);
}

/** JSON from a file, any size (readTextFile stops at 500k characters); null if there's no file. */
function readJson(path: string): unknown {
  const file = new java.io.File(path);
  if (!file.isFile()) return null;
  const bytes = java.nio.file.Files.readAllBytes(file.toPath());
  return JSON.parse(String(new java.lang.String(bytes, "UTF-8")));
}

function writeJson(path: string, value: unknown): void {
  const text = JSON.stringify(value);
  const bytes = utf8(text);
  if (!writeBinaryFile(path, bytes)) throw new Error(`couldn't write ${path}`);
}

/** UTF-8 without TextEncoder (names and words aren't ASCII). */
function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(out);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

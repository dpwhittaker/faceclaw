import { readEventDetails } from "../../native/calendar";
import type { CalendarEventDetails } from "../../native/calendar-types";
import type { SpeakerSegment } from "../../native/transcript-format";
import { voiceControlBridge, type VoiceControlState, type VoiceTranscriptEvent } from "../../native/voice-control";
import { onAnySettingChanged } from "../../ui/dashboard-settings";
import { postAmbientCard, dismissAmbientCard } from "../../ui/shell/ambient-cards";
import type { LayerActions } from "../../ui/layers";
import { currentEvent, eventsOnNow, EARLY_JOIN_MS, occurrenceKey, seriesKey } from "./calendar-context";
import { type CueChannelStatus, type CueEventFrame } from "./cue-channel";
import { cueLink } from "./cue-link";
import { ASK_GRACE_MS, CueContexts, type CueChange, type CueContext, type CueSwitchTarget } from "./contexts";
import type { VoiceName } from "./after-conversation";
import { BACKFILL_MS, type RecordingContext } from "./cue-recordings";
import { cueCalendarScope, cueNewPersonSetting, cueOrgFor } from "./cue-settings";
import { YOU } from "./cue-voices";
import { contextTitle, switchChoices, type CueRecent, type CueSwitchChoice } from "./switch-choices";

/**
 * Cue's long-lived half: holds the mic (as the "cue" capture holder, on
 * Soniox), turns transcripts into speech for the context model and lines for
 * the backend, and keeps what the window shows. Outlives the window's
 * foreground state, like Microphones' session; the window's close stops it.
 */

const CAPTION_LINES_KEPT = 200;
const TICK_MS = 5_000;
const CALENDAR_CACHE_MS = 30_000;
const NOTIFY_INTERVAL_MS = 200;
const ASK_CARD_ID = "cue:meeting-over";
/** How often Cue asks for the mic again after losing it (the glasses reconnecting drops it). */
const MIC_RETRY_MS = 10_000;
const BYTES_PER_MS = 32;
const WHO_CHOICES = 20;

export type CueCaption = { contextId: string; speaker: string; text: string; atMs: number; final: boolean };

/**
 * A voice heard in a context: "Voice 1", "Voice 2"... in the order heard,
 * and who the backend says it is: "Priya", or "Priya?" while unconfirmed.
 */
export type CueVoice = { key: string; label: string; lastHeardMs: number; name: string; personId: string | null; confirmed: boolean };

/** Someone a voice could be, for Who's this?. */
export type CueWhoChoice = { personId: string; name: string; hint: string };

export type CueAnswer = { itemId: string | undefined; question: string; text: string; done: boolean };

export type CueState = {
  running: boolean;
  /** The capture's own status: "Listening (Soniox)...", "Waiting for the glasses...", an error. */
  status: string;
  listening: boolean;
  backend: CueChannelStatus;
  backendDetail: string;
  current: CueContext | null;
  paused: readonly CueContext[];
  askingEnded: boolean;
  /** Who spoke last in the current context, as the top line shows it ("Priya", "Priya?", "Voice 2"). */
  talking: string;
  /** That voice's label ("Voice 2"), for Who's this?. */
  talkingLabel: string;
  /** Voices heard in the current context, most recent first. */
  voices: CueVoice[];
  captions: CueCaption[];
  answers: ReadonlyMap<string, CueAnswer>;
  /** People and teams from the last 7 days, from the backend. */
  recent: CueRecent[];
};

class CueSession {
  private readonly contexts = new CueContexts(newId);
  private actions: LayerActions | null = null;
  private unsubscribers: (() => void)[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(state: CueState) => void>();
  private calendarCache: { atMs: number; events: CalendarEventDetails[] } | null = null;
  private captureState: VoiceControlState = { status: "Not listening.", listening: false, detail: "" };
  private captions: CueCaption[] = [];
  private partial: CueCaption[] = [];
  // Per context: voices by stream:label, numbered in the order first heard.
  private readonly voices = new Map<string, Map<string, CueVoice>>();
  private readonly answers = new Map<string, CueAnswer>();
  private talking = "";
  private talkingAtMs = 0;
  // The live transcription's stream per context: a new one restarts its voice numbers.
  private readonly streams = new Map<string, number>();
  private micRequestedMs = 0;
  // Where the last microphone chunk ended, on the transcription's clock.
  private audioEndMs = 0;
  // The voice Someone new names when its name is typed on the phone.
  private naming: { contextId: string; label: string } | null = null;

  get running(): boolean {
    return this.actions !== null;
  }

  /** The window opened: listen, and take the backend's conversation frames (the connection itself is cueLink's). */
  start(actions: LayerActions): void {
    if (this.actions) return;
    this.actions = actions;
    cueLink.setConversationHandler({
      onEndContext: (contextId) => {
        if (this.contexts.current?.id === contextId) this.apply(this.contexts.end(Date.now(), "claude"));
      },
      onAnswer: (askId, text, done) => {
        const answer = this.answers.get(askId);
        if (!answer) return;
        answer.text = text;
        answer.done = done;
        this.notify();
      },
      onContextAck: (contextId, candidates) => cueLink.voices.setCandidates(contextId, candidates),
      onSpeaker: (speaker) => {
        cueLink.voices.named(speaker);
        this.notify();
      },
    });
    this.unsubscribers = [
      cueLink.onChange(() => this.notify()),
      voiceControlBridge.onRawPcm((bytes) => {
        const startMs = cueLink.voices.push(bytes, Date.now());
        this.audioEndMs = startMs + bytes.length / BYTES_PER_MS;
        cueLink.recordings.append(bytes, startMs);
      }),
      voiceControlBridge.onAudioOrigin((originMs) => cueLink.voices.anchor(originMs)),
      onAnySettingChanged(() => this.onNewPersonTyped()),
      voiceControlBridge.onTranscript((event) => this.onTranscript(event)),
      voiceControlBridge.onStatus((state) => {
        this.captureState = state;
        this.notify();
      }),
    ];
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.micRequestedMs = Date.now();
    void actions.startContinuousVoiceCapture("cue");
    this.notify();
  }

  stop(): void {
    const actions = this.actions;
    if (!actions) return;
    this.apply(this.contexts.stop(Date.now()));
    cueLink.setConversationHandler(null);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.actions = null;
    void actions.stopContinuousVoiceCapture("cue");
    this.partial = [];
    this.notify();
  }

  onState(listener: (state: CueState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => this.listeners.delete(listener);
  }

  state(): CueState {
    const current = this.contexts.current;
    const voices = current ? [...(this.voices.get(current.id)?.values() ?? [])].map((voice) => this.named(current.id, voice)).sort((a, b) => b.lastHeardMs - a.lastHeardMs) : [];
    return {
      running: this.running,
      status: this.captureState.status,
      listening: this.captureState.listening,
      backend: cueLink.backendStatus,
      backendDetail: cueLink.backendDetail,
      current,
      paused: this.contexts.paused,
      askingEnded: this.contexts.askingEnded,
      talking: current && this.talking ? this.displayName(current.id, this.talking, this.talkingAtMs) : "",
      talkingLabel: current ? this.talking : "",
      voices,
      captions: [...this.captions, ...this.partial].map((caption) => (caption.speaker ? { ...caption, speaker: this.displayName(caption.contextId, caption.speaker, caption.atMs) } : caption)),
      answers: this.answers,
      recent: this.recent(),
    };
  }

  private recent(): CueRecent[] {
    return cueLink.recent.map((person) => ({ kind: "person", id: person.personId, name: person.name, lastTalkedMs: person.lastTalked }));
  }

  private tick(): void {
    const nowMs = Date.now();
    this.apply(this.contexts.tick(nowMs));
    // A full voice stop (the glasses reconnecting after the charger, a dropped
    // connection) releases Cue's mic hold; ask again until the glasses are back.
    if (this.actions && !voiceControlBridge.isHeldBy("cue") && nowMs - this.micRequestedMs >= MIC_RETRY_MS) {
      this.micRequestedMs = nowMs;
      console.log("[Cue] microphone hold lost; asking again");
      void this.actions.startContinuousVoiceCapture("cue");
    }
  }

  /** What the Switch menu offers right now. */
  switchChoices(formatTime: (ms: number) => string): CueSwitchChoice[] {
    const nowMs = Date.now();
    const state = this.state();
    return switchChoices(eventsOnNow(this.calendar(nowMs), nowMs, cueCalendarScope()), state.paused, this.recent(), state.current, nowMs, formatTime);
  }

  switchTo(target: CueSwitchTarget): void {
    this.apply(this.contexts.switchTo(target, Date.now()));
  }

  /** End conversation, or "yes" to "Meeting over early?". */
  endCurrent(): void {
    this.apply(this.contexts.end(Date.now(), "user"));
  }

  /** Who a voice could be: you, the context's candidates closest first, then people from this week. */
  whoChoices(): CueWhoChoice[] {
    const current = this.contexts.current;
    if (!current) return [];
    const choices: CueWhoChoice[] = [{ personId: YOU, name: "You", hint: "" }];
    const seen = new Set([YOU]);
    const hints: Record<number, string> = { 1: "here", 2: "team", 3: "org" };
    for (const candidate of cueLink.voices.candidatesFor(current.id)) {
      if (seen.has(candidate.personId)) continue;
      seen.add(candidate.personId);
      choices.push({ personId: candidate.personId, name: candidate.name, hint: hints[candidate.tier] ?? "" });
    }
    for (const person of cueLink.recent) {
      if (seen.has(person.personId)) continue;
      seen.add(person.personId);
      choices.push({ personId: person.personId, name: person.name, hint: "recent" });
    }
    return choices.slice(0, WHO_CHOICES);
  }

  /**
   * The wearer says who a voice is (Who's this?, or confirming "Dana?"):
   * the backend takes the name, and the voice's latest audio trains that
   * person's voice-print.
   */
  nameVoice(label: string, personId: string, name: string): void {
    const current = this.contexts.current;
    if (!current || !label) return;
    cueLink.channel.correctSpeaker(current.id, label, personId);
    cueLink.voices.named({ contextId: current.id, speaker: label, personId, name, confidence: "high", confirmed: true });
    this.notify();
  }

  /** Someone new: their name comes from the phone's text editor (cueNewPersonSetting). */
  nameNewVoice(label: string): void {
    const current = this.contexts.current;
    if (!current || !label) return;
    this.naming = { contextId: current.id, label };
    cueNewPersonSetting.set("");
  }

  private onNewPersonTyped(): void {
    const name = cueNewPersonSetting.get().trim();
    const naming = this.naming;
    if (!name || !naming) return;
    this.naming = null;
    cueNewPersonSetting.set("");
    if (this.contexts.current?.id !== naming.contextId) return;
    // The backend makes the person and names the voice; its speaker frame trains the print.
    cueLink.channel.correctSpeaker(naming.contextId, naming.label, null, name);
    cueLink.voices.named({ contextId: naming.contextId, speaker: naming.label, personId: null, name, confidence: "high", confirmed: false });
    this.notify();
  }

  /** Asks the backend about a cue (by entry id) or the conversation; returns the id its answer arrives under. */
  ask(itemId: string | undefined, question: string): string | null {
    const current = this.contexts.current;
    if (!current) return null;
    const askId = newId();
    this.answers.set(askId, { itemId, question, text: "", done: false });
    cueLink.channel.ask(current.id, askId, itemId, question);
    this.notify();
    return askId;
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (!this.actions || !event.text.trim()) {
      if (event.isFinal) this.partial = [];
      return;
    }
    const segments = (event.segments ?? []).filter((segment) => segment.text);
    const nowMs = Date.now();
    // Speech time: the end of the latest words, else now for providers without timings.
    const atMs = segments.length ? Math.max(...segments.map((segment) => segment.endMs)) : nowMs;
    this.apply(this.contexts.current ? this.contexts.heard(atMs, null) : this.contexts.heard(atMs, this.eventNow(nowMs)));
    const current = this.contexts.current;
    const contextId = current?.id ?? "";
    const lines = segments.length
      ? segments.map((segment) => ({ contextId, speaker: current ? this.voice(current, segment) : "", text: segment.text, atMs: segment.startMs, final: event.isFinal }))
      : [{ contextId, speaker: "", text: event.text.trim(), atMs, final: event.isFinal }];
    if (event.isFinal) {
      this.captions.push(...lines);
      if (this.captions.length > CAPTION_LINES_KEPT) this.captions.splice(0, this.captions.length - CAPTION_LINES_KEPT);
      this.partial = [];
      if (current) {
        if (segments.length) {
          for (const [index, segment] of segments.entries()) {
            const label = lines[index].speaker;
            this.noticeStream(current.id, segment);
            cueLink.channel.line(current.id, label, segment.text, segment.startMs, segment.endMs);
            cueLink.recordings.line(current.id, { label, text: segment.text, startMs: segment.startMs, endMs: segment.endMs });
            cueLink.voices.heard(current.id, label, segment.startMs, segment.endMs);
          }
        } else {
          cueLink.channel.line(current.id, "", event.text.trim(), atMs, atMs);
          cueLink.recordings.line(current.id, { label: "", text: event.text.trim(), startMs: atMs, endMs: atMs });
        }
      }
    } else {
      this.partial = lines;
    }
    const last = lines[lines.length - 1];
    if (last?.speaker) {
      this.talking = last.speaker;
      this.talkingAtMs = last.atMs;
    }
    this.notify();
  }

  /** A segment from a new transcription stream: its voice numbers started over, which the backend tells Claude. */
  private noticeStream(contextId: string, segment: SpeakerSegment): void {
    if (!segment.speaker) return;
    const previous = this.streams.get(contextId);
    this.streams.set(contextId, segment.stream);
    if (previous === undefined || previous === segment.stream) return;
    console.log(`[Cue] ${contextId}: transcription restarted (stream ${previous} → ${segment.stream})`);
    cueLink.channel.voicesReset(contextId, segment.startMs);
  }

  /** The context's name for a Soniox label: "Voice N", numbered as first heard, stable across reconnects' new streams. */
  private voice(context: CueContext, segment: SpeakerSegment): string {
    if (!segment.speaker) return "";
    let voices = this.voices.get(context.id);
    if (!voices) this.voices.set(context.id, (voices = new Map()));
    const key = `${segment.stream}:${segment.speaker}`;
    let voice = voices.get(key);
    if (!voice) {
      voice = { key, label: `Voice ${voices.size + 1}`, lastHeardMs: 0, name: "", personId: null, confirmed: false };
      voices.set(key, voice);
    }
    voice.lastHeardMs = Math.max(voice.lastHeardMs, segment.endMs);
    return voice.label;
  }

  /** A voice with the backend's name for it. */
  private named(contextId: string, voice: CueVoice): CueVoice {
    const speaker = cueLink.voices.speaker(contextId, voice.label);
    return speaker ? { ...voice, name: speaker.name, personId: speaker.personId, confirmed: speaker.confirmed } : voice;
  }

  /**
   * Who said a line: the run's voice-print when it was sure (live voices get
   * reused for other people), else the backend's name for the voice ("Priya",
   * or "Priya?" unconfirmed), else the label.
   */
  private displayName(contextId: string, label: string, atMs: number): string {
    const heard = cueLink.voices.identityAt(contextId, label, atMs);
    if (heard) return heard.name;
    const speaker = cueLink.voices.speaker(contextId, label);
    if (!speaker?.name) return label;
    return speaker.confirmed ? speaker.name : `${speaker.name}?`;
  }

  /** Every voice of a context with its final name, for the recording. */
  private voiceNames(contextId: string): VoiceName[] {
    return [...(this.voices.get(contextId)?.values() ?? [])].map((voice) => {
      const speaker = cueLink.voices.speaker(contextId, voice.label);
      return { label: voice.label, personId: speaker?.personId ?? null, name: speaker?.name ?? "", confidence: speaker?.confidence ?? "low", confirmed: speaker?.confirmed ?? false };
    });
  }

  /** The recording's start: the speech just before the first words, not already in another context's recording. */
  private backfill(atMs: number): { pcm: Uint8Array; startMs: number } | null {
    if (!this.audioEndMs) return null;
    const startMs = Math.max(atMs - BACKFILL_MS, cueLink.recordings.recordedUntilMs);
    const pcm = cueLink.voices.slice(startMs, this.audioEndMs);
    return pcm.length ? { pcm, startMs: this.audioEndMs - pcm.length / BYTES_PER_MS } : null;
  }

  private eventNow(nowMs: number): CalendarEventDetails | null {
    return currentEvent(this.calendar(nowMs), nowMs, cueCalendarScope());
  }

  private calendar(nowMs: number): CalendarEventDetails[] {
    if (!this.calendarCache || nowMs - this.calendarCache.atMs >= CALENDAR_CACHE_MS) {
      this.calendarCache = { atMs: nowMs, events: readEventDetails(nowMs, nowMs + EARLY_JOIN_MS, 50) };
    }
    return this.calendarCache.events;
  }

  private apply(changes: CueChange[]): void {
    if (!changes.length) return;
    for (const change of changes) {
      const context = change.context;
      console.log(`[Cue] ${change.type} ${context.id} ${contextTitle(context)}${change.type === "end" ? ` (${change.reason})` : ""}`);
      switch (change.type) {
        case "start":
          cueLink.channel.switchTo(switchFrame(context, change.atMs));
          cueLink.voices.beginContext(context.id, context.event?.location);
          cueLink.recordings.begin(recordingContext(context), this.backfill(change.atMs));
          this.talking = "";
          break;
        case "resume":
          cueLink.channel.switchTo({ atMs: change.atMs, contextId: context.id });
          cueLink.recordings.begin(recordingContext(context), null);
          this.talking = "";
          break;
        case "pause":
          // The switch that follows tells the backend; a pause alone never happens.
          cueLink.voices.closeRun(context.id);
          cueLink.recordings.pause();
          break;
        case "end":
          cueLink.channel.contextEnd(context.id, change.atMs, change.reason);
          cueLink.recordings.end(context.id, change.atMs, this.voiceNames(context.id), cueLink.voices.candidatesFor(context.id));
          cueLink.voices.endContext(context.id);
          this.streams.delete(context.id);
          if (this.naming?.contextId === context.id) this.naming = null;
          this.voices.delete(context.id);
          this.talking = "";
          break;
        case "ask-ended":
          postAmbientCard({
            id: ASK_CARD_ID,
            title: "Meeting over early?",
            lines: [contextTitle(context), "Open Cue and click to end it"],
            expiresAtMs: change.atMs + ASK_GRACE_MS,
          });
          break;
        case "ask-ended-cleared":
          dismissAmbientCard(ASK_CARD_ID);
          break;
      }
    }
    this.notify();
  }

  /** Coalesce bursts of partial transcripts into at most 5 repaints a second. */
  private notify(): void {
    if (this.notifyTimer !== null) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const state = this.state();
      for (const listener of this.listeners) listener(state);
    }, NOTIFY_INTERVAL_MS);
  }
}

/** What the recording keeps about a context, for the hand-off. */
function recordingContext(context: CueContext): RecordingContext {
  return {
    id: context.id,
    title: contextTitle(context),
    kind: context.kind,
    org: cueOrgFor(context.event?.calendarName ?? null, context.parts[0]?.startMs ?? Date.now()),
    location: context.event?.location ?? "",
    startedMs: context.parts[0]?.startMs ?? Date.now(),
  };
}

/** The backend's view of a new context: its kind, event or people, organization and team. */
function switchFrame(context: CueContext, atMs: number) {
  const event = context.event;
  return {
    atMs,
    contextId: context.id,
    kind: context.kind,
    event: event ? eventFrame(event) : undefined,
    people: context.people.length ? context.people : undefined,
    org: cueOrgFor(event?.calendarName ?? null, atMs),
    team: context.team?.teamId,
  };
}

function eventFrame(event: CalendarEventDetails): CueEventFrame {
  const emails = new Set(cueCalendarScope().emails.map((email) => email.toLowerCase()));
  return {
    key: occurrenceKey(event),
    seriesKey: seriesKey(event),
    title: event.title,
    start: event.startMs,
    end: event.endMs,
    calendar: event.calendarName,
    location: event.location,
    description: event.description.slice(0, 8000),
    attendees: event.attendees.map((attendee) => ({
      name: attendee.name,
      email: attendee.email,
      type: attendee.type,
      self: emails.has(attendee.email.toLowerCase()),
    })),
  };
}

function newId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export const cueSession = new CueSession();

import { readEventDetails } from "../../native/calendar";
import type { CalendarEventDetails } from "../../native/calendar-types";
import type { SpeakerSegment } from "../../native/transcript-format";
import { voiceControlBridge, type VoiceControlState, type VoiceTranscriptEvent } from "../../native/voice-control";
import { postAmbientCard, dismissAmbientCard } from "../../ui/shell/ambient-cards";
import { onAnySettingChanged } from "../../ui/dashboard-settings";
import type { LayerActions } from "../../ui/layers";
import { currentEvent, eventsOnNow, EARLY_JOIN_MS, occurrenceKey, seriesKey } from "./calendar-context";
import { CueChannel, type CueChannelStatus, type CueEventFrame, type CueListItem, type CueTransportFactory } from "./cue-channel";
import { ASK_GRACE_MS, CueContexts, type CueChange, type CueContext, type CueSwitchTarget } from "./contexts";
import { cueBackendTokenSetting, cueBackendUrlSetting, cueCalendarScope, cueOrgFor } from "./cue-settings";
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

export type CueCaption = { speaker: string; text: string; atMs: number; final: boolean };

/** A voice heard in a context: "Voice 1", "Voice 2"... until voice-prints name it. */
export type CueVoice = { key: string; label: string; lastHeardMs: number };

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
  /** Who spoke last in the current context, as the top line shows it. */
  talking: string;
  /** Voices heard in the current context, most recent first. */
  voices: CueVoice[];
  /** The backend's list for the current context. */
  items: CueListItem[];
  captions: CueCaption[];
  answers: ReadonlyMap<string, CueAnswer>;
  /** People and teams from the last 7 days, from the backend. */
  recent: CueRecent[];
};

class CueSession {
  private readonly contexts = new CueContexts(newId);
  private channel: CueChannel | null = null;
  private actions: LayerActions | null = null;
  private unsubscribers: (() => void)[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(state: CueState) => void>();
  private calendarCache: { atMs: number; events: CalendarEventDetails[] } | null = null;
  private captureState: VoiceControlState = { status: "Not listening.", listening: false, detail: "" };
  private backend: CueChannelStatus = "offline";
  private backendDetail = "";
  private captions: CueCaption[] = [];
  private partial: CueCaption[] = [];
  // Per context: voices by stream:label, numbered in the order first heard.
  private readonly voices = new Map<string, Map<string, CueVoice>>();
  private readonly items = new Map<string, CueListItem[]>();
  private readonly answers = new Map<string, CueAnswer>();
  private talking = "";
  private recent: CueRecent[] = [];
  // The backend address and token the channel runs with, to notice edits.
  private backendConfig = "";

  get running(): boolean {
    return this.actions !== null;
  }

  start(actions: LayerActions, transport: CueTransportFactory): void {
    if (this.actions) return;
    this.actions = actions;
    this.channel = new CueChannel(transport, {
      onStatus: (status, detail) => {
        this.backend = status;
        this.backendDetail = detail;
        this.notify();
      },
      onRecent: (recent) => {
        this.recent = recent.map((person) => ({ kind: "person", id: person.personId, name: person.name, lastTalkedMs: person.lastTalked }));
        this.notify();
      },
      onList: (contextId, items) => {
        this.items.set(contextId, items);
        this.notify();
      },
      onPopup: (popup) => {
        postAmbientCard({ id: `cue:${popup.id}`, title: popup.title, lines: popup.lines, expiresAtMs: Date.now() + popup.seconds * 1000 });
      },
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
    });
    this.connectBackend();
    this.unsubscribers = [
      onAnySettingChanged(() => this.connectBackend()),
      voiceControlBridge.onTranscript((event) => this.onTranscript(event)),
      voiceControlBridge.onStatus((state) => {
        this.captureState = state;
        this.notify();
      }),
    ];
    this.tickTimer = setInterval(() => this.apply(this.contexts.tick(Date.now())), TICK_MS);
    void actions.startContinuousVoiceCapture("cue");
    this.notify();
  }

  stop(): void {
    const actions = this.actions;
    if (!actions) return;
    this.apply(this.contexts.stop(Date.now()));
    this.channel?.stop();
    this.channel = null;
    this.backendConfig = "";
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.actions = null;
    void actions.stopContinuousVoiceCapture("cue");
    this.partial = [];
    this.notify();
  }

  /** (Re)connects when the backend address or token changed, re-announcing the current context. */
  private connectBackend(): void {
    const channel = this.channel;
    if (!channel) return;
    const url = cueBackendUrlSetting.get();
    const token = cueBackendTokenSetting.get();
    const config = `${url}\n${token}`;
    if (config === this.backendConfig) return;
    this.backendConfig = config;
    if (!url || !token) {
      channel.stop();
      this.backendDetail = "Set Cue's backend address and token in the menu.";
      this.notify();
      return;
    }
    const nowMs = Date.now();
    channel.start(url, token, newId(), cueOrgFor(null, nowMs));
    const current = this.contexts.current;
    if (current) channel.switchTo(switchFrame(current, nowMs));
  }

  onState(listener: (state: CueState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => this.listeners.delete(listener);
  }

  state(): CueState {
    const current = this.contexts.current;
    const voices = current ? [...(this.voices.get(current.id)?.values() ?? [])].sort((a, b) => b.lastHeardMs - a.lastHeardMs) : [];
    return {
      running: this.running,
      status: this.captureState.status,
      listening: this.captureState.listening,
      backend: this.backend,
      backendDetail: this.backendDetail,
      current,
      paused: this.contexts.paused,
      askingEnded: this.contexts.askingEnded,
      talking: current ? this.talking : "",
      voices,
      items: current ? this.items.get(current.id) ?? [] : [],
      captions: [...this.captions, ...this.partial],
      answers: this.answers,
      recent: this.recent,
    };
  }

  /** What the Switch menu offers right now. */
  switchChoices(formatTime: (ms: number) => string): CueSwitchChoice[] {
    const nowMs = Date.now();
    const state = this.state();
    return switchChoices(eventsOnNow(this.calendar(nowMs), nowMs, cueCalendarScope()), state.paused, this.recent, state.current, nowMs, formatTime);
  }

  switchTo(target: CueSwitchTarget): void {
    this.apply(this.contexts.switchTo(target, Date.now()));
  }

  /** End conversation, or "yes" to "Meeting over early?". */
  endCurrent(): void {
    this.apply(this.contexts.end(Date.now(), "user"));
  }

  /** Asks the backend about an item (or the conversation); returns the id its answer arrives under. */
  ask(itemId: string | undefined, question: string): string | null {
    const current = this.contexts.current;
    if (!current || !this.channel) return null;
    const askId = newId();
    this.answers.set(askId, { itemId, question, text: "", done: false });
    this.channel.ask(current.id, askId, itemId, question);
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
    const lines = segments.length
      ? segments.map((segment) => ({ speaker: current ? this.voice(current, segment) : "", text: segment.text, atMs: segment.startMs, final: event.isFinal }))
      : [{ speaker: "", text: event.text.trim(), atMs, final: event.isFinal }];
    if (event.isFinal) {
      this.captions.push(...lines);
      if (this.captions.length > CAPTION_LINES_KEPT) this.captions.splice(0, this.captions.length - CAPTION_LINES_KEPT);
      this.partial = [];
      if (current) {
        if (segments.length) {
          for (const [index, segment] of segments.entries()) this.channel?.line(current.id, lines[index].speaker, segment.text, segment.startMs, segment.endMs);
        } else {
          this.channel?.line(current.id, "", event.text.trim(), atMs, atMs);
        }
      }
    } else {
      this.partial = lines;
    }
    const last = lines[lines.length - 1];
    if (last?.speaker) this.talking = last.speaker;
    this.notify();
  }

  /** The context's name for a Soniox label: "Voice N", numbered as first heard, stable across reconnects' new streams. */
  private voice(context: CueContext, segment: SpeakerSegment): string {
    if (!segment.speaker) return "";
    let voices = this.voices.get(context.id);
    if (!voices) this.voices.set(context.id, (voices = new Map()));
    const key = `${segment.stream}:${segment.speaker}`;
    let voice = voices.get(key);
    if (!voice) {
      voice = { key, label: `Voice ${voices.size + 1}`, lastHeardMs: 0 };
      voices.set(key, voice);
    }
    voice.lastHeardMs = Math.max(voice.lastHeardMs, segment.endMs);
    return voice.label;
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
          this.channel?.switchTo(switchFrame(context, change.atMs));
          this.talking = "";
          break;
        case "resume":
          this.channel?.switchTo({ atMs: change.atMs, contextId: context.id });
          this.talking = "";
          break;
        case "pause":
          // The switch that follows tells the backend; a pause alone never happens.
          break;
        case "end":
          this.channel?.contextEnd(context.id, change.atMs, change.reason);
          this.voices.delete(context.id);
          this.items.delete(context.id);
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

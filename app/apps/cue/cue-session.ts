import { readEventDetails } from "../../native/calendar";
import type { CalendarEventDetails } from "../../native/calendar-types";
import type { SpeakerSegment } from "../../native/transcript-format";
import { voiceControlBridge, type VoiceControlState, type VoiceTranscriptEvent } from "../../native/voice-control";
import { postAmbientCard, dismissAmbientCard } from "../../ui/shell/ambient-cards";
import type { LayerActions } from "../../ui/layers";
import { currentEvent, eventsOnNow, EARLY_JOIN_MS } from "./calendar-context";
import { ASK_GRACE_MS, CueContexts, type CueChange, type CueContext, type CueSwitchTarget } from "./contexts";
import { cueCalendarScope } from "./cue-settings";
import { contextTitle, switchChoices, type CueRecent, type CueSwitchChoice } from "./switch-choices";

/**
 * Cue's long-lived half: holds the mic (as the "cue" capture holder, on
 * Soniox), turns transcripts into speech for the context model, and keeps
 * what the window shows. Outlives the window's foreground state, like
 * Microphones' session; the window's close stops it.
 */

const CAPTION_LINES_KEPT = 200;
const TICK_MS = 5_000;
const CALENDAR_CACHE_MS = 30_000;
const NOTIFY_INTERVAL_MS = 200;
const ASK_CARD_ID = "cue:meeting-over";

export type CueCaption = { speaker: string; text: string; atMs: number; final: boolean };

/** A voice heard in a context: a Soniox label within one stream until voice-prints name it. */
export type CueVoice = { key: string; label: string; lastHeardMs: number };

export type CueState = {
  running: boolean;
  /** The capture's own status: "Listening (Soniox)...", "Waiting for the glasses...", an error. */
  status: string;
  listening: boolean;
  current: CueContext | null;
  paused: readonly CueContext[];
  askingEnded: boolean;
  /** Who spoke last in the current context, as the top line shows it. */
  talking: string;
  /** Voices heard in the current context, most recent first. */
  voices: CueVoice[];
  captions: CueCaption[];
  /** People and teams from the last 7 days, once the backend supplies them. */
  recent: CueRecent[];
};

class CueSession {
  private readonly contexts = new CueContexts(newContextId);
  private actions: LayerActions | null = null;
  private unsubscribers: (() => void)[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(state: CueState) => void>();
  private calendarCache: { atMs: number; events: CalendarEventDetails[] } | null = null;
  private captureState: VoiceControlState = { status: "Not listening.", listening: false, detail: "" };
  private captions: CueCaption[] = [];
  private partial: CueCaption[] = [];
  // Voices by context id; each map keyed by stream:label.
  private readonly voices = new Map<string, Map<string, CueVoice>>();
  private talking = "";
  private recent: CueRecent[] = [];

  get running(): boolean {
    return this.actions !== null;
  }

  start(actions: LayerActions): void {
    if (this.actions) return;
    this.actions = actions;
    this.unsubscribers = [
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
    const voices = current ? [...(this.voices.get(current.id)?.values() ?? [])].sort((a, b) => b.lastHeardMs - a.lastHeardMs) : [];
    return {
      running: this.running,
      status: this.captureState.status,
      listening: this.captureState.listening,
      current,
      paused: this.contexts.paused,
      askingEnded: this.contexts.askingEnded,
      talking: current ? this.talking : "",
      voices,
      captions: [...this.captions, ...this.partial],
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

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (!this.actions || !event.text.trim()) {
      if (event.isFinal) this.partial = [];
      return;
    }
    const segments = (event.segments ?? []).filter((segment) => segment.text);
    const nowMs = Date.now();
    // Speech time: the end of the latest words, else now for providers without timings.
    const atMs = segments.length ? Math.max(...segments.map((segment) => segment.endMs)) : nowMs;
    const changes = this.contexts.current ? this.contexts.heard(atMs, null) : this.contexts.heard(atMs, this.eventNow(nowMs));
    this.apply(changes);
    const lines = segments.length
      ? segments.map((segment) => this.caption(segment, event.isFinal))
      : [{ speaker: "", text: event.text.trim(), atMs, final: event.isFinal }];
    if (event.isFinal) {
      this.captions.push(...lines);
      if (this.captions.length > CAPTION_LINES_KEPT) this.captions.splice(0, this.captions.length - CAPTION_LINES_KEPT);
      this.partial = [];
    } else {
      this.partial = lines;
    }
    const last = lines[lines.length - 1];
    if (last?.speaker) this.talking = last.speaker;
    this.notify();
  }

  private caption(segment: SpeakerSegment, final: boolean): CueCaption {
    const label = segment.speaker ? `Speaker ${segment.speaker}` : "";
    const current = this.contexts.current;
    if (current && segment.speaker) {
      let voices = this.voices.get(current.id);
      if (!voices) this.voices.set(current.id, (voices = new Map()));
      const key = `${segment.stream}:${segment.speaker}`;
      const voice = voices.get(key) ?? { key, label, lastHeardMs: 0 };
      voice.lastHeardMs = Math.max(voice.lastHeardMs, segment.endMs);
      voices.set(key, voice);
    }
    return { speaker: label, text: segment.text, atMs: segment.startMs, final };
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
      console.log(`[Cue] ${change.type} ${change.context.id} ${contextTitle(change.context)}${change.type === "end" ? ` (${change.reason})` : ""}`);
      if (change.type === "ask-ended") {
        postAmbientCard({
          id: ASK_CARD_ID,
          title: "Meeting over early?",
          lines: [contextTitle(change.context), "Open Cue and click to end it"],
          expiresAtMs: change.atMs + ASK_GRACE_MS,
        });
      } else if (change.type === "ask-ended-cleared") {
        dismissAmbientCard(ASK_CARD_ID);
      } else if (change.type === "end") {
        this.voices.delete(change.context.id);
      }
      if (change.type === "start" || change.type === "resume" || change.type === "end" || change.type === "pause") {
        this.talking = "";
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

function newContextId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export const cueSession = new CueSession();

import type { CalendarEventDetails } from "../../native/calendar-types";
import { occurrenceKey } from "./calendar-context";

/**
 * Cue's conversation contexts: which one is current, which meetings are
 * paused, and when each starts, pauses, resumes and ends. Pure (the caller
 * supplies times, the calendar and ids) so it runs under node tests.
 *
 * Rules, from the Cue design doc:
 * - Speech with nothing current starts a context: the meeting happening now
 *   (resuming it if paused), otherwise an ad-hoc one. A meeting that already
 *   ended doesn't restart on its own; pick it from Switch.
 * - Switching away from an ad-hoc context ends it; away from a meeting,
 *   pauses it. Switching back to a paused meeting resumes it as a new part.
 * - SILENCE_END_MS without speech ends the current context. Before a
 *   meeting's calendar end it asks "Meeting over early?" instead, which
 *   speech dismisses; unanswered, the meeting ends ASK_GRACE_MS later.
 * - A paused meeting ends PAUSED_GRACE_MS after its calendar end, so it is
 *   transcribed even if you never switch back.
 */

export const SILENCE_END_MS = 60 * 1000;
export const ASK_GRACE_MS = 2 * 60 * 1000;
export const PAUSED_GRACE_MS = 30 * 60 * 1000;

export type CuePerson = { personId: string; name: string };

export type CueContext = {
  /** Made on the phone; names the recording folder and the backend's context. */
  id: string;
  kind: "scheduled" | "adhoc";
  /** The calendar event of a scheduled context. */
  event: CalendarEventDetails | null;
  /** Occurrence key of the event, "" for ad-hoc. */
  eventKey: string;
  /** The people or team picked for an ad-hoc context; voices join later. */
  people: CuePerson[];
  /** Stretches of this context; a resumed meeting has several. The last is open while current. */
  parts: { startMs: number; endMs: number | null }[];
  lastSpeechMs: number;
};

export type CueEndReason =
  /** End conversation, or "yes" to "Meeting over early?". */
  | "user"
  /** Switched away from an ad-hoc context. */
  | "switched"
  | "silence"
  /** Claude heard the meeting wrap up (end_meeting). */
  | "claude"
  /** Cue stopped. */
  | "stopped"
  /** Paused past its calendar end. */
  | "expired";

export type CueChange =
  | { type: "start" | "pause" | "resume"; context: CueContext; atMs: number }
  | { type: "end"; context: CueContext; atMs: number; reason: CueEndReason }
  /** Show or clear the "Meeting over early?" pop-up for the current meeting. */
  | { type: "ask-ended"; context: CueContext; atMs: number }
  | { type: "ask-ended-cleared"; context: CueContext; atMs: number };

export type CueSwitchTarget =
  | { type: "event"; event: CalendarEventDetails }
  | { type: "paused"; contextId: string }
  | { type: "new"; people?: CuePerson[] };

export class CueContexts {
  private currentContext: CueContext | null = null;
  // Most recently paused first.
  private pausedContexts: CueContext[] = [];
  // Occurrence keys of meetings that ended, so they don't restart on speech.
  private readonly endedEventKeys = new Set<string>();
  private askingSinceMs: number | null = null;

  constructor(private readonly newId: () => string) {}

  get current(): CueContext | null {
    return this.currentContext;
  }

  get paused(): readonly CueContext[] {
    return this.pausedContexts;
  }

  /** Whether "Meeting over early?" is showing. */
  get askingEnded(): boolean {
    return this.askingSinceMs !== null;
  }

  /** Someone spoke at atMs; eventNow is the calendar's pick for that moment (see currentEvent). */
  heard(atMs: number, eventNow: CalendarEventDetails | null): CueChange[] {
    const changes: CueChange[] = [];
    const current = this.currentContext;
    if (current) {
      current.lastSpeechMs = Math.max(current.lastSpeechMs, atMs);
      if (this.askingSinceMs !== null) {
        this.askingSinceMs = null;
        changes.push({ type: "ask-ended-cleared", context: current, atMs });
      }
      return changes;
    }
    const key = eventNow ? occurrenceKey(eventNow) : "";
    if (eventNow && !this.endedEventKeys.has(key)) {
      const paused = this.pausedContexts.find((context) => context.eventKey === key);
      if (paused) return this.resume(paused, atMs);
      return this.begin("scheduled", eventNow, [], atMs);
    }
    return this.begin("adhoc", null, [], atMs);
  }

  /** Time passing: silence and paused meetings running past their end. */
  tick(nowMs: number): CueChange[] {
    const changes: CueChange[] = [];
    for (const context of [...this.pausedContexts]) {
      if (context.event && nowMs >= context.event.endMs + PAUSED_GRACE_MS) {
        changes.push(...this.finish(context, context.parts[context.parts.length - 1].endMs ?? nowMs, "expired"));
      }
    }
    const current = this.currentContext;
    if (!current) return changes;
    const silentSinceMs = current.lastSpeechMs;
    if (this.askingSinceMs !== null) {
      if (nowMs - this.askingSinceMs >= ASK_GRACE_MS) changes.push(...this.finish(current, silentSinceMs, "silence"));
      return changes;
    }
    if (nowMs - silentSinceMs < SILENCE_END_MS) return changes;
    if (current.kind === "scheduled" && current.event && nowMs < current.event.endMs) {
      this.askingSinceMs = nowMs;
      changes.push({ type: "ask-ended", context: current, atMs: nowMs });
      return changes;
    }
    changes.push(...this.finish(current, silentSinceMs, "silence"));
    return changes;
  }

  /** A choice from the Switch menu. */
  switchTo(target: CueSwitchTarget, atMs: number): CueChange[] {
    if (target.type === "paused") {
      const paused = this.pausedContexts.find((context) => context.id === target.contextId);
      return paused ? [...this.leaveCurrent(atMs), ...this.resume(paused, atMs)] : [];
    }
    if (target.type === "event") {
      const key = occurrenceKey(target.event);
      if (this.currentContext?.eventKey === key) return [];
      const paused = this.pausedContexts.find((context) => context.eventKey === key);
      if (paused) return [...this.leaveCurrent(atMs), ...this.resume(paused, atMs)];
      // Picking an ended meeting again starts it afresh.
      this.endedEventKeys.delete(key);
      return [...this.leaveCurrent(atMs), ...this.begin("scheduled", target.event, [], atMs)];
    }
    return [...this.leaveCurrent(atMs), ...this.begin("adhoc", null, target.people ?? [], atMs)];
  }

  /** End the current context now: End conversation, "Meeting over early?" answered, or end_meeting. */
  end(atMs: number, reason: "user" | "claude"): CueChange[] {
    return this.currentContext ? this.finish(this.currentContext, atMs, reason) : [];
  }

  /** Cue stopped: everything ends, paused meetings included, so all of it is transcribed. */
  stop(atMs: number): CueChange[] {
    const changes = this.currentContext ? this.finish(this.currentContext, atMs, "stopped") : [];
    for (const context of [...this.pausedContexts]) {
      changes.push(...this.finish(context, context.parts[context.parts.length - 1].endMs ?? atMs, "stopped"));
    }
    return changes;
  }

  private begin(kind: CueContext["kind"], event: CalendarEventDetails | null, people: CuePerson[], atMs: number): CueChange[] {
    const context: CueContext = {
      id: this.newId(),
      kind,
      event,
      eventKey: event ? occurrenceKey(event) : "",
      people,
      parts: [{ startMs: atMs, endMs: null }],
      lastSpeechMs: atMs,
    };
    this.currentContext = context;
    return [{ type: "start", context, atMs }];
  }

  private resume(context: CueContext, atMs: number): CueChange[] {
    this.pausedContexts = this.pausedContexts.filter((paused) => paused !== context);
    context.parts.push({ startMs: atMs, endMs: null });
    context.lastSpeechMs = atMs;
    this.currentContext = context;
    return [{ type: "resume", context, atMs }];
  }

  /** Switching away: an ad-hoc context ends, a meeting pauses. */
  private leaveCurrent(atMs: number): CueChange[] {
    const current = this.currentContext;
    if (!current) return [];
    if (current.kind === "adhoc") return this.finish(current, atMs, "switched");
    this.closePart(current, atMs);
    this.clearAsk();
    this.currentContext = null;
    this.pausedContexts.unshift(current);
    return [{ type: "pause", context: current, atMs }];
  }

  private finish(context: CueContext, atMs: number, reason: CueEndReason): CueChange[] {
    const changes: CueChange[] = [];
    if (context === this.currentContext) {
      if (this.askingSinceMs !== null) changes.push({ type: "ask-ended-cleared", context, atMs });
      this.clearAsk();
      this.currentContext = null;
    }
    this.pausedContexts = this.pausedContexts.filter((paused) => paused !== context);
    this.closePart(context, atMs);
    if (context.eventKey) this.endedEventKeys.add(context.eventKey);
    changes.push({ type: "end", context, atMs, reason });
    return changes;
  }

  private closePart(context: CueContext, atMs: number): void {
    const part = context.parts[context.parts.length - 1];
    if (part.endMs === null) part.endMs = Math.max(part.startMs, atMs);
  }

  private clearAsk(): void {
    this.askingSinceMs = null;
  }
}

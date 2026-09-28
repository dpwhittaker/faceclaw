import type { CalendarEventDetails } from "../../native/calendar-types";

/**
 * Which calendar event a scheduled Cue context belongs to, and the keys Cue
 * files its notes and attachments under. Pure, so it runs under node tests.
 */

/** A meeting starting this soon is listed as "now": people join calls early. */
export const EARLY_JOIN_MS = 5 * 60 * 1000;

/**
 * Key of the event, or of the whole series for a recurring one; every
 * occurrence shares it, including one moved or edited on its own. The sync
 * adapter's id (Google's event id) when there is one, so it survives a
 * reinstall; otherwise the Android row id, prefixed "android-".
 */
export function seriesKey(event: CalendarEventDetails): string {
  if (event.originalSyncId) return event.originalSyncId;
  if (event.originalId) return `android-${event.originalId}`;
  return event.syncId || `android-${event.id}`;
}

/**
 * Key of this one occurrence. For a recurring event it is the series key plus
 * the time the occurrence was originally scheduled (Google's own instance-id
 * format), so moving an occurrence keeps its key. A one-off event's key is its
 * series key.
 */
export function occurrenceKey(event: CalendarEventDetails): string {
  const series = seriesKey(event);
  if (!event.recurring) return series;
  const scheduledMs = event.originalInstanceMs || event.startMs;
  return `${series}_${instanceStamp(scheduledMs, event.allDay)}`;
}

/** 20260928T150000Z, or 20260928 for an all-day occurrence (stored at UTC midnight). */
function instanceStamp(ms: number, allDay: boolean): string {
  const iso = new Date(ms).toISOString(); // 2026-09-28T15:00:00.000Z
  const date = iso.slice(0, 10).replace(/-/g, "");
  return allDay ? date : `${date}T${iso.slice(11, 19).replace(/:/g, "")}Z`;
}

/**
 * The events Switch lists as happening now, best first: timed events you
 * haven't declined that are under way or start within EARLY_JOIN_MS. Ones
 * already under way come first; then ones you're required at (or organized,
 * or that are yours alone) before ones you're optional at or not invited to;
 * then the most recently started, since a meeting that just began usually
 * sits inside a longer block.
 */
export function eventsOnNow(events: CalendarEventDetails[], nowMs: number): CalendarEventDetails[] {
  return events
    .filter((event) =>
      !event.allDay &&
      event.status !== "canceled" &&
      event.selfStatus !== "declined" &&
      selfAttendee(event)?.status !== "declined" &&
      event.startMs <= nowMs + EARLY_JOIN_MS &&
      nowMs < event.endMs)
    .sort((a, b) =>
      Number(a.startMs > nowMs) - Number(b.startMs > nowMs) ||
      attendanceRank(a) - attendanceRank(b) ||
      b.startMs - a.startMs ||
      (a.endMs - a.startMs) - (b.endMs - b.startMs) ||
      a.id - b.id);
}

/** The event a scheduled context starts from right now, or null. */
export function currentEvent(events: CalendarEventDetails[], nowMs: number): CalendarEventDetails | null {
  return eventsOnNow(events, nowMs)[0] ?? null;
}

function selfAttendee(event: CalendarEventDetails) {
  return event.attendees.find((attendee) => attendee.self);
}

/** 0: you're required, organized it, or it has no guests; 1: optional, or you're not on the list. */
function attendanceRank(event: CalendarEventDetails): number {
  const self = selfAttendee(event);
  if (!self) return event.attendees.length === 0 ? 0 : 1;
  return self.type === "optional" || self.type === "resource" ? 1 : 0;
}

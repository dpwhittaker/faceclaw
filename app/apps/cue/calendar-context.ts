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
 * Who "you" are to the calendar. A phone can sync several people's accounts
 * (a spouse's, a shared family one), so neither the calendar's owner nor the
 * syncing account says which attendee is you.
 */
export type CalendarScope = {
  /** Your addresses, matched case-insensitively against attendees and syncing accounts. */
  emails: string[];
  /**
   * Calendars whose events are yours whether or not you're on the guest list.
   * Unset: every calendar synced through one of your addresses.
   */
  calendarIds?: number[];
};

function normalizedEmails(scope: CalendarScope): Set<string> {
  return new Set(scope.emails.map((email) => email.trim().toLowerCase()).filter(Boolean));
}

/** Your attendee entry, if you're on the guest list. */
export function yourAttendee(event: CalendarEventDetails, scope: CalendarScope) {
  const emails = normalizedEmails(scope);
  return event.attendees.find((attendee) => emails.has(attendee.email.toLowerCase()));
}

function onYourCalendar(event: CalendarEventDetails, scope: CalendarScope): boolean {
  if (scope.calendarIds) return scope.calendarIds.includes(event.calendarId);
  return normalizedEmails(scope).has(event.accountName.toLowerCase());
}

/**
 * An event on one of your calendars, or one you're invited to. With no
 * addresses configured every event counts, since there's nothing to tell by.
 */
export function isYourEvent(event: CalendarEventDetails, scope: CalendarScope): boolean {
  if (normalizedEmails(scope).size === 0 && !scope.calendarIds) return true;
  return onYourCalendar(event, scope) || yourAttendee(event, scope) !== undefined;
}

/** Your response: from your guest-list entry, else the calendar's own if the calendar is yours. */
function yourResponse(event: CalendarEventDetails, scope: CalendarScope) {
  const attendee = yourAttendee(event, scope);
  if (attendee) return attendee.status;
  return normalizedEmails(scope).has(event.accountName.toLowerCase()) ? event.selfStatus : "none";
}

/**
 * The events Switch lists as happening now, best first: your timed events
 * you haven't declined that are under way or start within EARLY_JOIN_MS.
 * Ones already under way come first; then ones you're required at (or
 * organized, or that have no guest list) before ones you're optional at or
 * not on the guest list of; then the most recently started, since a meeting
 * that just began usually sits inside a longer block.
 */
export function eventsOnNow(events: CalendarEventDetails[], nowMs: number, scope: CalendarScope): CalendarEventDetails[] {
  return events
    .filter((event) =>
      !event.allDay &&
      event.status !== "canceled" &&
      isYourEvent(event, scope) &&
      yourResponse(event, scope) !== "declined" &&
      event.startMs <= nowMs + EARLY_JOIN_MS &&
      nowMs < event.endMs)
    .sort((a, b) =>
      Number(a.startMs > nowMs) - Number(b.startMs > nowMs) ||
      attendanceRank(a, scope) - attendanceRank(b, scope) ||
      b.startMs - a.startMs ||
      (a.endMs - a.startMs) - (b.endMs - b.startMs) ||
      a.id - b.id);
}

/** The event a scheduled context starts from right now, or null. */
export function currentEvent(events: CalendarEventDetails[], nowMs: number, scope: CalendarScope): CalendarEventDetails | null {
  return eventsOnNow(events, nowMs, scope)[0] ?? null;
}

/** 0: you're required, organized it, or it has no guest list; 1: optional, or you're not on the list. */
function attendanceRank(event: CalendarEventDetails, scope: CalendarScope): number {
  const you = yourAttendee(event, scope);
  if (!you) return event.attendees.length === 0 ? 0 : 1;
  return you.type === "optional" || you.type === "resource" ? 1 : 0;
}

import type { MeetingNotice } from "./meeting-notifications";

/**
 * Whether a meeting notice needs a new Work calendar event, a move of one Cue
 * made earlier, or nothing. Pure, so it runs under node tests.
 */

/** An event already on one of your calendars. */
export type ExistingEvent = { id: number; title: string; startMs: number; endMs: number };

/** An event Cue added, remembered so a re-sent invitation can move it. */
export type CreatedMeeting = { eventId: number; title: string; startMs: number; endMs: number; source: MeetingNotice["source"] };

export type MeetingPlan =
  | { action: "create" }
  | { action: "update"; eventId: number }
  | { action: "skip"; reason: "past" | "exists" | "unchanged" };

/** How far apart a notice's start and an event's may be and still be the same meeting. */
const SAME_START_MS = 2 * 60 * 1000;
/** Teams says "started" when the first person joins, which can be late. */
const STARTED_SLACK_MS = 20 * 60 * 1000;
/** How far an invitation may move a meeting and still count as rescheduling it. */
const RESCHEDULE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function planMeeting(
  meeting: MeetingNotice,
  existing: ExistingEvent[],
  created: CreatedMeeting[],
  nowMs: number,
): MeetingPlan {
  if (meeting.endMs <= nowMs) return { action: "skip", reason: "past" };
  const title = normalizeTitle(meeting.title);
  const slack = meeting.source === "started" ? STARTED_SLACK_MS : SAME_START_MS;
  const same = existing.find((event) => normalizeTitle(event.title) === title && Math.abs(event.startMs - meeting.startMs) <= slack);
  if (same) {
    if (meeting.source !== "invitation") return { action: "skip", reason: "exists" };
    const record = created.find((candidate) => candidate.eventId === same.id);
    // A re-sent invitation for a meeting Cue made: only a changed length matters.
    return record && same.endMs !== meeting.endMs ? { action: "update", eventId: same.id } : { action: "skip", reason: "unchanged" };
  }
  // Another, later meeting already running under this title (Teams' notice for one already on the calendar).
  if (meeting.source === "started" && existing.some((event) => normalizeTitle(event.title) === title && event.startMs <= meeting.startMs && meeting.startMs < event.endMs)) {
    return { action: "skip", reason: "exists" };
  }
  if (meeting.source === "invitation") {
    // A rescheduled meeting: an upcoming one Cue made from an invitation with the same title.
    const moved = created
      .filter((record) => record.source === "invitation" && normalizeTitle(record.title) === title && record.endMs > nowMs)
      .filter((record) => Math.abs(record.startMs - meeting.startMs) <= RESCHEDULE_WINDOW_MS)
      .sort((a, b) => Math.abs(a.startMs - meeting.startMs) - Math.abs(b.startMs - meeting.startMs))[0];
    if (moved && existing.some((event) => event.id === moved.eventId)) return { action: "update", eventId: moved.eventId };
  }
  return { action: "create" };
}

/** Titles compared without forwarding prefixes, tags, case or punctuation. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\s*((fw|fwd|re|updated|canceled|cancelled)\s*:\s*)+/g, "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

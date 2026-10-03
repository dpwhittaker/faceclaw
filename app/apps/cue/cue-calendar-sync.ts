import { Utils } from "@nativescript/core";
import { hasCalendarWritePermission } from "../../g2/android-permissions";
import { invalidateCalendarCache, readEventDetails } from "../../native/calendar";
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { isYourEvent } from "./calendar-context";
import { cueCalendarScope, cueWorkCalendarSetting } from "./cue-settings";
import type { MeetingNotice } from "./meeting-notifications";
import { planMeeting, type CreatedMeeting } from "./meeting-sync";

declare const com: any;
declare const java: any;

const CREATED_KEY = "cue.createdMeetings";
const CREATED_KEPT = 200;
const WAITING_KEPT = 50;
// Google's calendar access levels: contributor (500) and up can add events.
const CAN_WRITE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Puts work meetings from Outlook invitations and reminders (and Teams'
 * "meeting has started") on your Work calendar, unless they're already on
 * one of your calendars; a re-sent invitation moves the meeting Cue made.
 * Notices that arrive before Cue may write the calendar wait (in memory)
 * until it may.
 */
export class CueCalendarSync {
  private waiting: MeetingNotice[] = [];

  start(): void {
    // Retry anything that waited for the permission once it's granted.
    setInterval(() => this.retry(), 60_000);
  }

  handle(meeting: MeetingNotice): void {
    if (!hasCalendarWritePermission()) {
      this.waiting.push(meeting);
      if (this.waiting.length > WAITING_KEPT) this.waiting.shift();
      console.log(`[Cue] calendar: "${meeting.title}" waits for calendar access`);
      return;
    }
    try {
      this.apply(meeting);
    } catch (error) {
      console.warn(`[Cue] calendar: couldn't add "${meeting.title}": ${String(error)}`);
    }
  }

  private retry(): void {
    if (!this.waiting.length || !hasCalendarWritePermission()) return;
    for (const meeting of this.waiting.splice(0)) this.handle(meeting);
  }

  private apply(meeting: MeetingNotice): void {
    const context = Utils.android.getApplicationContext();
    const nowMs = Date.now();
    const scope = cueCalendarScope();
    const from = Math.min(meeting.startMs, nowMs) - DAY_MS;
    const to = Math.max(meeting.startMs, nowMs) + 8 * DAY_MS;
    const existing = readEventDetails(from, to, 200)
      .filter((event) => isYourEvent(event, scope))
      .map((event) => ({ id: event.id, title: event.title, startMs: event.startMs, endMs: event.endMs }));
    const created = this.created().filter((record) => record.endMs > nowMs - 7 * DAY_MS);
    const plan = planMeeting(meeting, existing, created, nowMs);
    if (plan.action === "skip") {
      console.log(`[Cue] calendar: "${meeting.title}" skipped (${plan.reason})`);
      return;
    }
    if (plan.action === "update") {
      const ok = com.faceclaw.app.FaceclawCalendarProvider.updateEvent(context, plan.eventId, meeting.title, meeting.startMs, meeting.endMs, meeting.location);
      if (ok) {
        this.save(created.map((record) => (record.eventId === plan.eventId ? { ...record, startMs: meeting.startMs, endMs: meeting.endMs } : record)));
        invalidateCalendarCache();
      }
      console.log(`[Cue] calendar: "${meeting.title}" moved: ${ok}`);
      return;
    }
    const calendarId = this.workCalendarId(context, scope.emails);
    if (calendarId === null) {
      console.warn(`[Cue] calendar: no writable calendar named "${cueWorkCalendarSetting.get()}" on your accounts`);
      return;
    }
    const description = `Added by Cue from an Outlook ${meeting.source === "started" ? "Teams notice" : meeting.source}.${meeting.description ? `\n\n${meeting.description}` : ""}`;
    const eventId = Number(com.faceclaw.app.FaceclawCalendarProvider.insertEvent(
      context, calendarId, meeting.title, meeting.startMs, meeting.endMs, meeting.location, description, String(java.util.TimeZone.getDefault().getID()),
    ));
    if (eventId > 0) {
      this.save([...created, { eventId, title: meeting.title, startMs: meeting.startMs, endMs: meeting.endMs, source: meeting.source }]);
      invalidateCalendarCache();
    }
    console.log(`[Cue] calendar: "${meeting.title}" added: ${eventId}`);
  }

  private workCalendarId(context: any, emails: string[]): number | null {
    const name = cueWorkCalendarSetting.get().toLowerCase();
    const yours = new Set(emails.map((email) => email.toLowerCase()));
    const calendars = JSON.parse(String(com.faceclaw.app.FaceclawCalendarProvider.getCalendarsJson(context))) as {
      id: number; name: string; accountName: string; accessLevel: number;
    }[];
    const match = calendars.find((calendar) =>
      calendar.name.toLowerCase() === name && calendar.accessLevel >= CAN_WRITE && (!yours.size || yours.has(calendar.accountName.toLowerCase())));
    return match ? match.id : null;
  }

  private created(): CreatedMeeting[] {
    try {
      const parsed = JSON.parse(getStringSetting(CREATED_KEY, "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private save(records: CreatedMeeting[]): void {
    setStringSetting(CREATED_KEY, JSON.stringify(records.slice(-CREATED_KEPT)));
  }
}

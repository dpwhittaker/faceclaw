export type CalendarEvent = {
  /** Android event ID or EventKit event identifier. */
  id: number | string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  location: string;
  calendarName: string;
};

export type CalendarReadState = "ready" | "loading" | "error";

export type CalendarResponse = "accepted" | "declined" | "tentative" | "invited" | "none";

export type CalendarAttendee = {
  name: string;
  email: string;
  /** How the invitation lists them; rooms and equipment are "resource". */
  type: "required" | "optional" | "resource" | "none";
  role: "organizer" | "attendee" | "performer" | "speaker" | "none";
  status: CalendarResponse;
};

/**
 * An occurrence with the details Cue needs (Android only). Fields past
 * CalendarEvent's are empty when the provider can't supply them.
 */
export type CalendarEventDetails = CalendarEvent & {
  id: number;
  description: string;
  organizer: string;
  /** The response of the account the calendar syncs through: yours only if accountName is yours. */
  selfStatus: CalendarResponse;
  status: "confirmed" | "tentative" | "canceled";
  /** Part of a recurring series, including an occurrence moved or edited on its own. */
  recurring: boolean;
  /** The sync adapter's event id: Google's event id for a Google calendar, "" for a local one. */
  syncId: string;
  /** For an occurrence moved or edited on its own: the series' Android event id, else 0. */
  originalId: number;
  /** For an occurrence moved or edited on its own: the series' sync id, else "". */
  originalSyncId: string;
  /** For an occurrence moved or edited on its own: when it was originally scheduled, else 0. */
  originalInstanceMs: number;
  calendarId: number;
  /** The account the calendar syncs through; a phone may sync several people's accounts. */
  accountName: string;
  /** The calendar's own address: an email, or a group-calendar id for a secondary calendar. */
  ownerAccount: string;
  /** Which attendee is you depends on your addresses; see apps/cue/calendar-context. */
  attendees: CalendarAttendee[];
};

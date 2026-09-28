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
  /** This attendee is the calendar's owner: you. */
  self: boolean;
};

/**
 * An occurrence with the details Cue needs (Android only). Fields past
 * CalendarEvent's are empty when the provider can't supply them.
 */
export type CalendarEventDetails = CalendarEvent & {
  id: number;
  description: string;
  organizer: string;
  /** Your response to the invitation. */
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
  attendees: CalendarAttendee[];
};

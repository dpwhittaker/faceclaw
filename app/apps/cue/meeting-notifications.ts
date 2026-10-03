/**
 * What a notification means to Cue: a meeting to put on the calendar
 * (an Outlook invitation or reminder, or Teams saying a meeting started),
 * calendar chatter to drop, or a message to triage. Pure, so it runs under
 * node tests.
 */

/** One notification as FaceclawNotificationFeed serializes it. */
export type FeedNotification = {
  key: string;
  profile: number;
  package: string;
  app: string;
  postTime: number;
  when: number;
  category: string;
  channelId: string;
  title: string;
  text: string;
  bigText: string;
  subText: string;
  conversationTitle: string;
  lines: string[];
  messages: { sender: string; text: string; time: number }[];
  actions: string[];
};

export type MeetingNotice = {
  source: "invitation" | "reminder" | "started";
  title: string;
  startMs: number;
  endMs: number;
  location: string;
  description: string;
};

export type NotificationRoute =
  | { kind: "meeting"; meeting: MeetingNotice }
  | { kind: "ignore" }
  | { kind: "triage" };

const OUTLOOK = "com.microsoft.office.outlook";
const TEAMS = "com.microsoft.teams";
/** A meeting Teams says has started is given this long when nothing says otherwise. */
export const STARTED_MEETING_MS = 30 * 60 * 1000;

export function routeNotification(notification: FeedNotification): NotificationRoute {
  if (notification.package === OUTLOOK && notification.channelId.includes("EVENT_REMINDER")) {
    const meeting = parseReminder(notification);
    return meeting ? { kind: "meeting", meeting } : { kind: "ignore" };
  }
  if (notification.package === OUTLOOK && notification.actions.includes("Yes") && notification.actions.includes("No")) {
    const meeting = parseInvitation(notification);
    // An invitation Cue can't read still reaches you, through triage.
    return meeting ? { kind: "meeting", meeting } : { kind: "triage" };
  }
  if (notification.package === TEAMS && notification.channelId.includes("MeetingNotifications")) {
    if (/meeting has started/i.test(notification.text) && notification.title.trim()) {
      return {
        kind: "meeting",
        meeting: {
          source: "started",
          title: notification.title.trim(),
          startMs: notification.postTime,
          endMs: notification.postTime + STARTED_MEETING_MS,
          location: "Microsoft Teams Meeting",
          description: "",
        },
      };
    }
    return { kind: "ignore" };
  }
  return { kind: "triage" };
}

/** "8:15 AM - 8:45 AM, Microsoft Teams Meeting", with the start in `when`. */
export function parseReminder(notification: FeedNotification): MeetingNotice | null {
  const title = notification.title.trim();
  const text = clean(notification.text || notification.bigText.split("\n")[0] || "");
  const match = /^(\d{1,2})(?::(\d{2}))? ?(AM|PM) ?- ?(\d{1,2})(?::(\d{2}))? ?(AM|PM)(?:, ?(.*))?$/i.exec(text);
  if (!title || !match || !notification.when) return null;
  const startMs = notification.when;
  const start = new Date(startMs);
  const end = new Date(startMs);
  end.setHours(hours24(Number(match[4]), match[6]), Number(match[5] ?? 0), 0, 0);
  // A meeting that runs past midnight ends the next day.
  if (end.getTime() <= start.getTime()) end.setDate(end.getDate() + 1);
  return { source: "reminder", title, startMs, endMs: end.getTime(), location: (match[7] ?? "").trim(), description: "" };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * An Outlook invitation's big text: the subject, then when ("Tomorrow at
 * 9:30 AM (30m)", "Thu, Oct 8, 8:30 AM (1h 30m)", "Mon, Nov 10, 2025, 1 PM
 * (30m)"), then where, then the invitation's body.
 */
export function parseInvitation(notification: FeedNotification): MeetingNotice | null {
  const lines = notification.bigText.split("\n");
  const title = (lines[0] || notification.text.split("•")[0] || "").trim();
  const when = clean(lines[1] ?? "");
  const match = new RegExp(
    "^(?:(today|tomorrow) at |(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*, (" + MONTHS.join("|") + ")[a-z]* (\\d{1,2})(?:, (\\d{4}))?, )" +
      "(\\d{1,2})(?::(\\d{2}))? ?(am|pm) ?\\((?:(\\d+)h)? ?(?:(\\d+)m)?\\)",
    "i",
  ).exec(when);
  if (!title || !match || (!match[8] && !match[9])) return null;
  const posted = new Date(notification.postTime);
  const start = new Date(posted);
  if (match[1]) {
    if (match[1].toLowerCase() === "tomorrow") start.setDate(start.getDate() + 1);
  } else {
    const month = MONTHS.indexOf(match[2].toLowerCase());
    const day = Number(match[3]);
    start.setFullYear(match[4] ? Number(match[4]) : posted.getFullYear(), month, day);
    // A date without a year that's well before the post is next year's.
    if (!match[4] && start.getTime() < posted.getTime() - 7 * 24 * 60 * 60 * 1000) start.setFullYear(start.getFullYear() + 1);
  }
  start.setHours(hours24(Number(match[5]), match[7]), Number(match[6] ?? 0), 0, 0);
  const minutes = Number(match[8] ?? 0) * 60 + Number(match[9] ?? 0);
  return {
    source: "invitation",
    title,
    startMs: start.getTime(),
    endMs: start.getTime() + minutes * 60 * 1000,
    location: (lines[2] ?? "").trim(),
    description: lines.slice(3).join("\n").trim(),
  };
}

/**
 * The id Cue files a notification under: the same for a repost of the same
 * content (Teams re-posts when you open it), different when the content
 * changes.
 */
export function notificationId(notification: FeedNotification): string {
  const content = [notification.package, notification.title, notification.text, notification.bigText.slice(0, 400),
    notification.messages.map((message) => `${message.sender}:${message.text}`).join("|")].join("\n");
  return `${fnv(content)}${fnv(`${content}#`)}`;
}

function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function clean(text: string): string {
  return text.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
}

function hours24(hours: number, meridiem: string): number {
  const pm = meridiem.toLowerCase() === "pm";
  if (hours === 12) return pm ? 12 : 0;
  return pm ? hours + 12 : hours;
}

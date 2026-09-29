import { ConfigSettingEnum, ConfigSettingString } from "../../ui/dashboard-settings";
import type { CalendarScope } from "./calendar-context";

/**
 * Your email addresses, comma-separated. Cue counts a calendar event as yours
 * when its calendar syncs through one of them or you're on its guest list;
 * the phone may also sync other people's accounts.
 */
export const cueEmailsSetting = new ConfigSettingString({
  id: "cue-emails",
  label: "Your addresses",
  storageKey: "cue.emails",
  defaultValue: "",
  editorTitle: "Your email addresses, comma-separated",
  glassesEditTitle: "Edit your addresses",
  inputKind: "text",
  description: "Cue treats calendar events as yours when they're on your own account's calendars or you're invited.",
  normalize: (value) => (value ?? "").split(/[,\s]+/).filter(Boolean).join(", "),
});

export const cueBackendUrlSetting = new ConfigSettingString({
  id: "cue-backend-url",
  label: "Backend",
  storageKey: "cue.backendUrl",
  defaultValue: "ws://127.0.0.1:8795",
  editorTitle: "Cue backend address (ws://host:port)",
  glassesEditTitle: "Edit backend address",
  description: "Where Cue's backend listens: on this phone (Termux) by default, or a home server on the tailnet.",
  normalize: (value) => (value ?? "").trim(),
});

export const cueBackendTokenSetting = new ConfigSettingString({
  id: "cue-backend-token",
  label: "Backend token",
  storageKey: "cue.backendToken",
  defaultValue: "",
  editorTitle: "Cue backend token (cue-data/.token)",
  glassesEditTitle: "Edit backend token",
  inputKind: "password",
  formatValue: (value) => (value ? `${value.slice(0, 4)}...` : "(not set)"),
  description: "The token the backend made on first run, in cue-data/.token.",
  normalize: (value) => (value ?? "").trim(),
});

export const CUE_ORGS = ["work", "church", "theater"] as const;
export type CueOrgChoice = "auto" | (typeof CUE_ORGS)[number];

/**
 * The organization a conversation belongs to. Auto: the calendar's name when
 * it names one (a "Work" calendar is Work), else Work on weekdays 8-6, else
 * none.
 */
export const cueOrgSetting = new ConfigSettingEnum<CueOrgChoice>({
  id: "cue-org",
  label: "Organization",
  storageKey: "cue.org",
  defaultValue: "auto",
  values: ["auto", ...CUE_ORGS],
  formatValue: (value) => (value === "auto" ? "Auto" : value[0].toUpperCase() + value.slice(1)),
  description: "Which organization's instructions apply. Auto follows the event's calendar, then Work on weekdays 8-6.",
});

export function cueCalendarScope(): CalendarScope {
  return { emails: cueEmailsSetting.get().split(/[,\s]+/).filter(Boolean) };
}

/** The organization for a conversation starting at atMs, from the setting, the event's calendar, then the schedule. */
export function cueOrgFor(calendarName: string | null, atMs: number): string {
  const choice = cueOrgSetting.get();
  if (choice !== "auto") return choice;
  const named = CUE_ORGS.find((org) => calendarName?.trim().toLowerCase() === org);
  if (named) return named;
  const date = new Date(atMs);
  const weekday = date.getDay() >= 1 && date.getDay() <= 5;
  return weekday && date.getHours() >= 8 && date.getHours() < 18 ? "work" : "";
}

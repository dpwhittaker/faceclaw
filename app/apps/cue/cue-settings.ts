import { ConfigSettingString } from "../../ui/dashboard-settings";
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

export function cueCalendarScope(): CalendarScope {
  return { emails: cueEmailsSetting.get().split(/[,\s]+/).filter(Boolean) };
}

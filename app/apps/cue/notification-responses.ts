/**
 * What the glasses can send back for a notification: its buttons that act
 * without opening an app (Mark as read, Archive...), the canned answers of
 * its reply field, and Android's suggested replies. FaceclawNotificationFeed
 * keeps each notification's actions from when it was posted until it's
 * removed, work-profile ones included; cue-link asks it. Pure, so it runs
 * under node tests.
 */

export type NotificationResponse = {
  /** The notification's key. */
  key: string;
  /** Which of its actions sends this. */
  index: number;
  /** The reply text, for an answer sent through a reply field. */
  reply: string | null;
  label: string;
};

const MAX_RESPONSES = 6;

/** The responses in the feed's JSON ([{title, action, reply}]), labeled "Mark as read" or `Reply: "On my way"`, without repeats. */
export function parseResponses(key: string, json: string): NotificationResponse[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const responses: NotificationResponse[] = [];
  for (const item of parsed) {
    const title = String(item?.title ?? "").trim();
    const reply = item?.reply == null ? null : String(item.reply).trim();
    if (!title || reply === "" || !Number.isInteger(item?.action)) continue;
    const label = reply === null ? title : `${title}: "${reply}"`;
    if (seen.has(label)) continue;
    seen.add(label);
    responses.push({ key, index: item.action, reply, label });
  }
  return responses.slice(0, MAX_RESPONSES);
}

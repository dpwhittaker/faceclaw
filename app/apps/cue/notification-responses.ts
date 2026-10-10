/**
 * What the glasses can send back for a notification: its buttons that act
 * without opening an app (Mark as read, Archive...), the canned answers of
 * its reply field, and for a field you'd type into, the three replies Claude
 * suggests from the message and its notebook on the sender (Android's own
 * suggestions until those arrive). FaceclawNotificationFeed keeps each
 * notification's actions from when it was posted until it's removed,
 * work-profile ones included; cue-link asks it. Pure, so it runs under node
 * tests.
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

const MAX_RESPONSES = 7;

export type ParsedResponses = {
  responses: NotificationResponse[];
  /** It has a reply field you'd type into, so Claude's suggestions belong here. */
  typed: boolean;
};

/**
 * The responses in the feed's JSON ([{title, action, reply, freeForm?,
 * suggested?}]), labeled "Mark as read" or `Reply: "On my way"`, without
 * repeats. Claude's suggestions (claude) go through the typed reply field
 * and replace Android's.
 */
export function parseResponses(key: string, json: string, claude: readonly string[] = []): ParsedResponses {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { responses: [], typed: false };
  }
  if (!Array.isArray(parsed)) return { responses: [], typed: false };
  const seen = new Set<string>();
  const responses: NotificationResponse[] = [];
  let typed = false;
  const add = (title: string, index: number, reply: string | null) => {
    const label = reply === null ? title : `${title}: "${reply}"`;
    if (seen.has(label)) return;
    seen.add(label);
    responses.push({ key, index, reply, label });
  };
  for (const item of parsed) {
    const title = String(item?.title ?? "").trim();
    const reply = item?.reply == null ? null : String(item.reply).trim();
    if (!title || reply === "" || !Number.isInteger(item?.action)) continue;
    if (item.freeForm) {
      typed = true;
      for (const suggestion of claude) if (suggestion.trim()) add(title, item.action, suggestion.trim());
    } else if (!(item.suggested && claude.length)) {
      add(title, item.action, reply);
    }
  }
  return { responses: responses.slice(0, MAX_RESPONSES), typed };
}

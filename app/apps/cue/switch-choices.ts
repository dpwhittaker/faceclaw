import type { CalendarEventDetails } from "../../native/calendar-types";
import { occurrenceKey } from "./calendar-context";
import type { CueContext, CuePerson, CueSwitchTarget } from "./contexts";

/** A person or team you talked with recently, from the backend's session-ack. */
export type CueRecent = { kind: "person" | "team"; id: string; name: string; lastTalkedMs: number; members?: CuePerson[] };

export type CueSwitchChoice = { label: string; target: CueSwitchTarget };

/**
 * The Switch menu: meetings happening now (best first, see eventsOnNow),
 * then paused meetings, then people and teams from the last 7 days, most
 * recent first. The current context is left out; New conversation is its
 * own menu item.
 */
export function switchChoices(
  eventsNow: CalendarEventDetails[],
  paused: readonly CueContext[],
  recent: CueRecent[],
  current: CueContext | null,
  nowMs: number,
  formatTime: (ms: number) => string,
): CueSwitchChoice[] {
  const choices: CueSwitchChoice[] = [];
  const pausedKeys = new Set(paused.map((context) => context.eventKey));
  for (const event of eventsNow) {
    const key = occurrenceKey(event);
    if (key === current?.eventKey || pausedKeys.has(key)) continue;
    const when = event.startMs > nowMs ? ` · ${formatTime(event.startMs)}` : "";
    choices.push({ label: `${event.title || "Untitled event"}${when}`, target: { type: "event", event } });
  }
  for (const context of paused) {
    const pausedAt = context.parts[context.parts.length - 1].endMs ?? nowMs;
    choices.push({ label: `${contextTitle(context)} · paused ${formatTime(pausedAt)}`, target: { type: "paused", contextId: context.id } });
  }
  const weekAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
  for (const item of [...recent].filter((r) => r.lastTalkedMs >= weekAgo).sort((a, b) => b.lastTalkedMs - a.lastTalkedMs)) {
    const target: CueSwitchTarget = item.kind === "person"
      ? { type: "new", people: [{ personId: item.id, name: item.name }] }
      : { type: "new", people: item.members ?? [], team: { teamId: item.id, name: item.name } };
    choices.push({ label: item.name, target });
  }
  return choices;
}

/** The context's name: its meeting's title, or who it's with. */
export function contextTitle(context: CueContext): string {
  if (context.event) return context.event.title || "Untitled event";
  if (context.team) return context.team.name;
  if (context.people.length) return context.people.map((person) => person.name).join(", ");
  return "Conversation";
}

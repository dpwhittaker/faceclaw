/**
 * The notebooks as Cue's main view shows them, and what you can do with an
 * entry. Notifications triage files and the cues Claude gives during
 * conversations are the same kind of entry: urgent, todo or status. Pure, so
 * it runs under node tests.
 */
import type { NotificationResponse } from "./notification-responses";

export type EntryCategory = "urgent" | "todo" | "status";

/** One entry, as the backend's notebooks frame carries it. */
export type NotebookEntry = {
  id: string;
  section: "day" | "status";
  day: string | null;
  /** Current category; null for what the memory run kept from a conversation. */
  category: EntryCategory | null;
  /** What Claude first said, for a notification's entry or a cue. */
  firstCategory: EntryCategory | null;
  text: string;
  nid: string | null;
  /** The conversation a cue came from; null for everything else. */
  contextId: string | null;
  /** The message's sender, or a cue's conversation. */
  title: string;
  /** The message, or a cue's detail. */
  body: string;
  /** Claude's suggested replies, for a message you'd answer by typing. */
  replies?: string[];
};

export type Notebook = {
  name: string;
  label: string;
  entries: NotebookEntry[];
  status: NotebookEntry[];
  statusCount: number;
};

export const ENTRY_ICONS: Record<EntryCategory, string> = { urgent: "‼", todo: "◆", status: "○" };

export type EntryOption = {
  label: string;
  /** keep: Back, leave it where it is; ask: Tell me more about a cue; respond: one of the notification's own responses. */
  action: "keep" | "dismiss" | "move" | "respond" | "ask";
  to?: EntryCategory;
  response?: NotificationResponse;
};

export const BACK: EntryOption = { label: "Back", action: "keep" };

/**
 * What an entry offers, by its current category: Back first (leave it for
 * later), Dismiss, and the other two categories, each move recording that
 * Claude's call was wrong. What the memory run kept has no category yet, so
 * it may go to any of the three.
 */
export function entryOptions(category: EntryCategory | null): EntryOption[] {
  switch (category) {
    case "urgent":
      return [
        BACK,
        { label: "Urgent – Dismiss", action: "dismiss" },
        { label: "Not urgent – TODO", action: "move", to: "todo" },
        { label: "Not urgent – Status", action: "move", to: "status" },
      ];
    case "todo":
      return [
        BACK,
        { label: "TODO – Dismiss", action: "dismiss" },
        { label: "Not TODO – Urgent", action: "move", to: "urgent" },
        { label: "Not TODO – Status", action: "move", to: "status" },
      ];
    case "status":
      return [
        BACK,
        { label: "Status – Dismiss", action: "dismiss" },
        { label: "Not status – TODO", action: "move", to: "todo" },
        { label: "Not status – Urgent", action: "move", to: "urgent" },
      ];
    default:
      return [
        BACK,
        { label: "Dismiss", action: "dismiss" },
        { label: "Make it urgent", action: "move", to: "urgent" },
        { label: "Make it TODO", action: "move", to: "todo" },
        { label: "Make it status", action: "move", to: "status" },
      ];
  }
}

/** Work on weekdays 8 to 6; every other notebook combined the rest of the time. */
export function idleNotebookNames(notebooks: Notebook[], nowMs: number): string[] {
  const now = new Date(nowMs);
  const workHours = now.getDay() >= 1 && now.getDay() <= 5 && now.getHours() >= 8 && now.getHours() < 18;
  return workHours ? ["work"] : notebooks.map((notebook) => notebook.name).filter((name) => name !== "work");
}

export type EntryRow =
  | { kind: "entry"; notebook: Notebook; entry: NotebookEntry; text: string }
  | { kind: "status"; count: number; text: string };

const RANK: Record<EntryCategory, number> = { urgent: 0, todo: 1, status: 3 };
const rank = (entry: NotebookEntry) => (entry.category ? RANK[entry.category] : 2);

/**
 * The main view's rows. In a conversation, its cues come first, status ones
 * too (they're what to have in view now): urgent, then todo, then status.
 * Then the shown notebooks' open entries, urgent first, then todo, then what
 * the memory run kept, each newest day first (in a combined view each
 * prefixed with its notebook). Then one line for the rest of the status
 * messages.
 */
export function entryRows(notebooks: Notebook[], names: string[], contextId: string | null = null): EntryRow[] {
  const shown = notebooks.filter((notebook) => names.includes(notebook.name));
  const combined = shown.length > 1;
  type Found = { notebook: Notebook; entry: NotebookEntry; index: number };
  const order = (a: Found, b: Found) => rank(a.entry) - rank(b.entry) || (b.entry.day ?? "").localeCompare(a.entry.day ?? "") || a.index - b.index;
  const live: Found[] = contextId
    ? notebooks.flatMap((notebook) => [...notebook.entries, ...notebook.status].map((entry, index) => ({ notebook, entry, index }))).filter(({ entry }) => entry.contextId === contextId)
    : [];
  const rest = shown.flatMap((notebook) => notebook.entries.map((entry, index) => ({ notebook, entry, index }))).filter(({ entry }) => !contextId || entry.contextId !== contextId);
  const rows: EntryRow[] = [...live.sort(order), ...rest.sort(order)].map(({ notebook, entry }) => ({
    kind: "entry",
    notebook,
    entry,
    text: `${entry.category ? `${ENTRY_ICONS[entry.category]} ` : "  "}${contextId && entry.contextId === contextId ? cueLine(entry) : `${combined ? `${notebook.label}: ` : ""}${dropTime(entry.text)}`}`,
  }));
  const inline = live.filter(({ notebook, entry }) => entry.section === "status" && shown.includes(notebook)).length;
  const count = shown.reduce((sum, notebook) => sum + notebook.statusCount, 0) - inline;
  if (count > 0) rows.push({ kind: "status", count, text: `${count} status message${count === 1 ? "" : "s"}` });
  return rows;
}

/** The status messages of the shown notebooks, newest first. */
export function statusEntries(notebooks: Notebook[], names: string[]): { notebook: Notebook; entry: NotebookEntry }[] {
  return notebooks
    .filter((notebook) => names.includes(notebook.name))
    .flatMap((notebook) => notebook.status.map((entry) => ({ notebook, entry })))
    .sort((a, b) => b.entry.text.localeCompare(a.entry.text));
}

/** A cue's line without its time or the conversation's name after it. */
export function cueLine(entry: NotebookEntry): string {
  const text = dropTime(entry.text);
  const suffix = entry.title ? ` · ${entry.title}` : "";
  return suffix && text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

/** An entry's text without its leading "13:41 " or "09-30 13:41 " (the list is already by date). */
export function dropTime(text: string): string {
  return text.replace(/^(\d{2}-\d{2} )?\d{2}:\d{2} /, "").replace(/^· /, "");
}

/**
 * Applies an action locally, so the glasses update before the backend's
 * next notebooks frame confirms it.
 */
export function applyLocally(notebooks: Notebook[], name: string, entryId: string, option: EntryOption): Notebook[] {
  if (option.action !== "dismiss" && option.action !== "move") return notebooks;
  return notebooks.map((notebook) => {
    if (notebook.name !== name) return notebook;
    const entry = [...notebook.entries, ...notebook.status].find((candidate) => candidate.id === entryId);
    if (!entry) return notebook;
    const entries = notebook.entries.filter((candidate) => candidate.id !== entryId);
    const status = notebook.status.filter((candidate) => candidate.id !== entryId);
    let statusCount = notebook.statusCount - (entry.section === "status" ? 1 : 0);
    if (option.action === "move" && option.to) {
      const moved: NotebookEntry = { ...entry, category: option.to, firstCategory: entry.firstCategory ?? entry.category, section: option.to === "status" ? "status" : "day" };
      if (option.to === "status") {
        status.unshift(moved);
        statusCount += 1;
      } else {
        entries.unshift(moved);
      }
    }
    return { ...notebook, entries, status, statusCount };
  });
}

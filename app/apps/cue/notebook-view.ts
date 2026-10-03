/**
 * The notebooks as Cue shows them between conversations, and what you can
 * do with an entry. Pure, so it runs under node tests.
 */

export type EntryCategory = "urgent" | "todo" | "status";

/** One entry, as the backend's notebooks frame carries it. */
export type NotebookEntry = {
  id: string;
  section: "day" | "status";
  day: string | null;
  /** Current category; null for an entry from a conversation. */
  category: EntryCategory | null;
  /** What Claude first said, for an entry a notification made. */
  firstCategory: EntryCategory | null;
  text: string;
  nid: string | null;
  title: string;
  body: string;
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
  action: "dismiss" | "move" | "keep";
  to?: EntryCategory;
};

/**
 * What an entry offers, by its current category: whether Claude's call was
 * right, and what to do with it. "Urgent – TODO" keeps an urgent entry in
 * the list for later; moves record a correction.
 */
export function entryOptions(category: EntryCategory | null): EntryOption[] {
  switch (category) {
    case "urgent":
      return [
        { label: "Urgent – Dismiss", action: "dismiss" },
        { label: "Urgent – TODO", action: "keep" },
        { label: "Not urgent – TODO", action: "move", to: "todo" },
        { label: "Not urgent – Status", action: "move", to: "status" },
      ];
    case "todo":
      return [
        { label: "TODO – Dismiss", action: "dismiss" },
        { label: "Not TODO – Urgent", action: "move", to: "urgent" },
        { label: "Not TODO – Status", action: "move", to: "status" },
      ];
    case "status":
      return [
        { label: "Status – Dismiss", action: "dismiss" },
        { label: "Not status – TODO", action: "move", to: "todo" },
        { label: "Not status – Urgent", action: "move", to: "urgent" },
      ];
    default:
      return [{ label: "Dismiss", action: "dismiss" }];
  }
}

/** Work on weekdays 8 to 6; every other notebook combined the rest of the time. */
export function idleNotebookNames(notebooks: Notebook[], nowMs: number): string[] {
  const now = new Date(nowMs);
  const workHours = now.getDay() >= 1 && now.getDay() <= 5 && now.getHours() >= 8 && now.getHours() < 18;
  return workHours ? ["work"] : notebooks.map((notebook) => notebook.name).filter((name) => name !== "work");
}

export type IdleRow =
  | { kind: "entry"; notebook: Notebook; entry: NotebookEntry; text: string }
  | { kind: "status"; count: number; text: string };

/**
 * The idle view's rows: open entries newest day first (in a combined view
 * each prefixed with its notebook), then one line for the status messages.
 */
export function idleRows(notebooks: Notebook[], names: string[]): IdleRow[] {
  const shown = notebooks.filter((notebook) => names.includes(notebook.name));
  const combined = shown.length > 1;
  const entries = shown.flatMap((notebook) => notebook.entries.map((entry, index) => ({ notebook, entry, index })));
  entries.sort((a, b) => (b.entry.day ?? "").localeCompare(a.entry.day ?? "") || a.index - b.index);
  const rows: IdleRow[] = entries.map(({ notebook, entry }) => ({
    kind: "entry",
    notebook,
    entry,
    text: `${entry.category ? `${ENTRY_ICONS[entry.category]} ` : "  "}${combined ? `${notebook.label}: ` : ""}${dropTime(entry.text)}`,
  }));
  const count = shown.reduce((sum, notebook) => sum + notebook.statusCount, 0);
  if (count) rows.push({ kind: "status", count, text: `${count} status message${count === 1 ? "" : "s"}` });
  return rows;
}

/** The status messages of the shown notebooks, newest first. */
export function statusEntries(notebooks: Notebook[], names: string[]): { notebook: Notebook; entry: NotebookEntry }[] {
  return notebooks
    .filter((notebook) => names.includes(notebook.name))
    .flatMap((notebook) => notebook.status.map((entry) => ({ notebook, entry })))
    .sort((a, b) => b.entry.text.localeCompare(a.entry.text));
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
  if (option.action === "keep") return notebooks;
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

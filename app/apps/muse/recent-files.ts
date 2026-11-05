import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { baseName } from "../teleprompter/recent-files";

/**
 * Muse's recently opened files, most recent first, with the word the reader
 * was at when it closed (so reopening resumes there). Sizes live in the
 * files themselves (see core/front-matter.ts); only places live here.
 */
export type RecentFile = {
  path: string;
  name: string;
  /** Word index the reader was at when last closed; 0 = start. */
  position: number;
  openedMs: number;
};

const RECENTS_KEY = "muse.recents";
const MAX_RECENTS = 12;

export function getRecentFiles(): RecentFile[] {
  try {
    const parsed: unknown = JSON.parse(getStringSetting(RECENTS_KEY, "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is RecentFile => !!entry && typeof entry === "object" && typeof entry.path === "string")
      .map((entry) => ({
        path: entry.path,
        name: typeof entry.name === "string" && entry.name ? entry.name : baseName(entry.path),
        position: typeof entry.position === "number" && entry.position >= 0 ? entry.position : 0,
        openedMs: typeof entry.openedMs === "number" ? entry.openedMs : 0,
      }));
  } catch {
    return [];
  }
}

function saveRecentFiles(recents: RecentFile[]): void {
  setStringSetting(RECENTS_KEY, JSON.stringify(recents.slice(0, MAX_RECENTS)));
}

/** Move (or add) a file to the top of the list, keeping its saved position. */
export function touchRecentFile(path: string, name: string): RecentFile {
  const recents = getRecentFiles();
  const existing = recents.find((entry) => entry.path === path);
  const entry: RecentFile = { path, name, position: existing?.position ?? 0, openedMs: Date.now() };
  saveRecentFiles([entry, ...recents.filter((other) => other.path !== path)]);
  return entry;
}

export function saveRecentFilePosition(path: string, position: number): void {
  const recents = getRecentFiles();
  const entry = recents.find((other) => other.path === path);
  if (!entry) return;
  entry.position = Math.max(0, position);
  saveRecentFiles(recents);
}

export function removeRecentFile(path: string): void {
  saveRecentFiles(getRecentFiles().filter((entry) => entry.path !== path));
}

export function clearRecentFiles(): void {
  saveRecentFiles([]);
}

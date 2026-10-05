import { Utils } from "@nativescript/core";
import { BibleData, type QueryFn } from "./bible-data";

declare const com: any;

/**
 * Where the Bible database lives on the phone: the app's external files
 * directory, so it can be pushed over adb without root
 * (scripts/bible/push_bible_db.sh) and replaced without reinstalling.
 */
export function bibleDatabasePath(): string {
  const context = Utils.android.getApplicationContext();
  return `${String(context.getExternalFilesDir(null).getAbsolutePath())}/bible/bible.sqlite`;
}

/** The database, or null when it hasn't been pushed to the phone yet. */
export function openBibleData(): BibleData | null {
  const path = bibleDatabasePath();
  const db = com.faceclaw.app.FaceclawReadOnlyDatabase;
  if (!db.exists(path)) return null;
  const query: QueryFn = (sql, args = []) => {
    const json = db.query(path, sql, JSON.stringify(args));
    if (json === null || json === undefined) throw new Error(`Bible query failed: ${sql}`);
    return JSON.parse(String(json)) as unknown[][];
  };
  return new BibleData(query);
}

/** Let go of the database file (before it is replaced). */
export function closeBibleData(): void {
  com.faceclaw.app.FaceclawReadOnlyDatabase.close(bibleDatabasePath());
}

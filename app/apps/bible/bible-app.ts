import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { type Layer, type LayerContext } from "../../ui/layers";
import { type MenuItem, TextPageLayer } from "../../ui/menu";
import {
  createInProcessWindow,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { type BibleData, type OriginalWord } from "./bible-data";
import { bibleDatabasePath, openBibleData } from "./bible-store";
import { parseVerseId, verseId, type VerseRef } from "./books";
import { PassagePicker } from "./passage-picker";
import { PassagePickerLayer } from "./picker-layer";
import { ReadingLayer } from "./reading-layer";
import { VerseStudyLayer } from "./verse-study-layer";
import { WordStudyLayer } from "./word-study-layer";

export const BIBLE_WINDOW_ID = "bible";
export const BIBLE_SURFACE_ID = "window:bible";

/** Where the reader last was, to open there next time. */
const LAST_VERSE_KEY = "bible.lastVerse";

export type BibleAppOptions = InProcessAppOptions & { appendLog: (message: string) => void };

/**
 * The Bible app's window, full height. Its base is the passage picker; every
 * view opened from there (a chapter to read, a verse's study page, a word's
 * study page, another passage followed from a reference) is pushed above it,
 * so double-tap works back through them in order, and from the picker's
 * outermost level leaves the app. It opens where the reader left off, with
 * the picker waiting underneath at that chapter's verses.
 */
export function createBibleAppWindow(options: BibleAppOptions): InProcessWindow {
  const data = openBibleData();
  if (!data) {
    options.appendLog(`bible: no database at ${bibleDatabasePath()}`);
    return createWindow(options, new MissingDataLayer(), () => []);
  }
  return createReaderWindow(options, data);
}

function createReaderWindow(options: BibleAppOptions, data: BibleData): InProcessWindow {
  const picker = new PassagePicker((book, chapter) => data.verseCount(book, chapter));
  const remember = (ref: VerseRef) => setStringSetting(LAST_VERSE_KEY, String(verseId(ref.book, ref.chapter, ref.verse)));

  const openWord = (word: OriginalWord, ctx: LayerContext) =>
    ctx.stack.push(new WordStudyLayer(word, { data, openReading: openReadingAt }));
  const openStudy = (id: number, ctx: LayerContext) =>
    ctx.stack.push(new VerseStudyLayer(id, { data, openReading: openReadingAt, openWord }));
  /**
   * A reading view. The one opened from the picker keeps the picker at its
   * chapter's verses as the reader moves on, so going back lands there.
   */
  const openReading = (ref: VerseRef, ctx: LayerContext, fromPicker = false) => {
    remember(ref);
    ctx.stack.push(new ReadingLayer(ref, {
      data,
      openStudy,
      onMoved: (moved) => {
        remember(moved);
        if (fromPicker) picker.showVerses(moved.book, moved.chapter);
      },
    }));
  };
  const openReadingAt = (id: number, ctx: LayerContext) => openReading(parseVerseId(id), ctx);

  const base = new PassagePickerLayer({
    picker,
    onPicked: (ref, ctx) => openReading(ref, ctx, true),
    onExit: () => shell.yieldFocusToSidebar(),
  });

  const created = createWindow(options, base, () => [
    {
      label: "Go to a passage",
      onSelect: (ctx) => {
        ctx.stack.pop();
        // A picker of its own above the current view, so going back returns here.
        const goTo = new PassagePickerLayer({
          picker: new PassagePicker((book, chapter) => data.verseCount(book, chapter)),
          onPicked: (ref, pickCtx) => {
            pickCtx.stack.popIfTop((layer) => layer === goTo);
            openReading(ref, pickCtx);
          },
          onExit: (exitCtx) => exitCtx.stack.popIfTop((layer) => layer === goTo),
        });
        ctx.stack.push(goTo);
      },
    },
    {
      label: "Choose a book",
      onSelect: (ctx) => {
        ctx.stack.clearToBase();
        picker.reset();
      },
    },
    {
      label: "About these texts",
      onSelect: (ctx) => {
        ctx.stack.pop();
        ctx.stack.push(new TextPageLayer("About these texts", `${data.meta("sources")}\n\nBuilt ${data.meta("built")}.`));
      },
    },
  ]);

  const last = Number(getStringSetting(LAST_VERSE_KEY, ""));
  const lastRef = last ? parseVerseId(last) : null;
  if (lastRef && data.verseCount(lastRef.book, lastRef.chapter) > 0) {
    picker.showVerses(lastRef.book, lastRef.chapter);
    openReading(lastRef, { stack: created.stack, actions: options.actions }, true);
  }
  return created;
}

function createWindow(
  options: BibleAppOptions,
  base: Layer,
  menuItems: () => MenuItem[],
): InProcessWindow {
  return createInProcessWindow({
    appId: "bible",
    windowId: BIBLE_WINDOW_ID,
    title: "Bible",
    iconLetter: "B",
    icon: "book-open",
    closeable: true,
    heightMode: "max",
    actions: options.actions,
    menuItems,
    baseLayer: base,
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    reconfigureSurface: options.reconfigureSurface,
    onClosed: options.onClosed,
  });
}

/** Shown when the database hasn't been put on the phone. */
class MissingDataLayer extends TextPageLayer {
  constructor() {
    super(
      "Bible data not installed",
      "The Bible's text, notes and lexicons are built on a computer and copied to the phone. " +
        "In the Faceclaw source tree, run scripts/bible/build_bible_db.py, then scripts/bible/push_bible_db.sh " +
        `with the phone connected over adb. It goes to ${bibleDatabasePath()}.`,
    );
  }

  handleInput(): void {
    shell.yieldFocusToSidebar();
  }
}

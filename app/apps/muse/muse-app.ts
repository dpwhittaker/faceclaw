import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText } from "../../graphics/textwrap";
import { readTextFile, writeBinaryFile, type DirectoryEntry } from "../../native/file-access";
import { LIST_ROW_TEXT_INSET } from "../../ui/metrics";
import { MenuLayer, type MenuItem } from "../../ui/menu";
import { type Layer, type LayerContext } from "../../ui/layers";
import { appViewportSize } from "../../ui/shell/geometry";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { FileBrowserLayer } from "../files/file-browser";
import { baseName, parentDirName } from "../teleprompter/recent-files";
import { buildDocument, fileKind, type FileKind } from "./core/document";
import { splitFrontMatter, writeSettings, type MuseSettings } from "./core/front-matter";
import { SAMPLE_MARKDOWN, SAMPLE_NAME } from "./core/sample";
import { MuseReaderLayer, type MuseReaderHooks } from "./reader";
import {
  clearRecentFiles,
  getRecentFiles,
  removeRecentFile,
  saveRecentFilePosition,
  touchRecentFile,
} from "./recent-files";

export const MUSE_WINDOW_ID = "muse:main";
/** In-process windows draw to `window:<windowId>` (see in-process-window.ts). */
export const MUSE_SURFACE_ID = `window:${MUSE_WINDOW_ID}`;

/** readTextFile stops at this many characters; writing back a cut-off file would lose its end. */
const READ_LIMIT_CHARS = 500_000;

const HOME_LAYOUT = {
  x: 8,
  y: 8,
  width: 272,
  showBorder: false,
  minHeight: 0,
  maxHeight: appViewportSize("min").height - 16,
  opaque: true,
};

export type MuseAppOptions = InProcessAppOptions & {
  /** Hold continuous mic capture while following the voice. */
  startContinuousVoiceCapture: () => void;
  stopContinuousVoiceCapture: () => void;
  appendLog: (message: string) => void;
};

/**
 * The Muse app window. The home page offers Browse, the built-in sample and
 * the recently opened files; Browse pushes the Files app's browser to pick a
 * Markdown, text or ABC file, and opening one pushes the reader (see
 * MuseReaderLayer) over the home page.
 */
export function createMuseAppWindow(options: MuseAppOptions): InProcessWindow {
  // Rebuilt in place whenever the recents change (MenuLayer reads the array each paint).
  const homeItems: MenuItem[] = [];
  const home = new MenuLayer("Muse", homeItems, HOME_LAYOUT);
  let created: InProcessWindow | null = null;
  let notice = "";
  // The sample has no file to keep its sizes in; they last until Faceclaw restarts.
  let sampleSettings: MuseSettings | null = null;

  const requestRender = () => created?.requestRender();

  const topLayer = (): Layer => {
    let top: Layer = home;
    created?.stack.topMatches((layer) => {
      top = layer;
      return true;
    });
    return top;
  };

  const readerHooks = (overrides: Pick<MuseReaderHooks, "savePosition" | "saveSettings">): MuseReaderHooks => ({
    requestRender,
    startCapture: () => options.startContinuousVoiceCapture(),
    stopCapture: () => options.stopContinuousVoiceCapture(),
    ...overrides,
  });

  const pushReader = (ctx: LayerContext, reader: MuseReaderLayer) => {
    ctx.stack.push(reader);
    reader.attach();
  };

  /** Write changed settings into the file, re-reading it first so edits made elsewhere survive. */
  const saveSettingsToFile = (path: string, kind: FileKind, settings: MuseSettings) => {
    const current = readTextFile(path);
    if (current === null || current.length >= READ_LIMIT_CHARS) {
      options.appendLog(`muse: did not save settings to ${path} (unreadable or too large)`);
      return;
    }
    const next = writeSettings(current, kind, settings);
    if (next === current) return;
    if (!writeBinaryFile(path, new TextEncoder().encode(next))) {
      options.appendLog(`muse: could not write settings to ${path}`);
    }
  };

  const openFile = (ctx: LayerContext, path: string, name: string) => {
    const kind = fileKind(name);
    const text = kind ? readTextFile(path) : null;
    if (!kind || text === null) {
      removeRecentFile(path);
      notice = `Could not read ${name}`;
      options.appendLog(`muse: could not read ${path}`);
      refreshHome();
      return;
    }
    const recent = touchRecentFile(path, name);
    notice = "";
    refreshHome();
    const { body, settings } = splitFrontMatter(text, kind);
    const reader = new MuseReaderLayer(
      buildDocument(body, kind),
      name,
      settings,
      readerHooks({
        savePosition: (position) => saveRecentFilePosition(path, position),
        saveSettings: (changed) => saveSettingsToFile(path, kind, changed),
      }),
      recent.position,
    );
    pushReader(ctx, reader);
  };

  const openSample = (ctx: LayerContext) => {
    const { body, settings } = splitFrontMatter(SAMPLE_MARKDOWN, "markdown");
    const reader = new MuseReaderLayer(
      buildDocument(body, "markdown"),
      SAMPLE_NAME,
      sampleSettings ?? settings,
      readerHooks({
        savePosition: () => {},
        saveSettings: (changed) => {
          sampleSettings = changed;
        },
      }),
    );
    pushReader(ctx, reader);
  };

  const openBrowser = (ctx: LayerContext) => {
    const stack = ctx.stack;
    const picker = new FileBrowserLayer({
      isSupportedFile: (name) => fileKind(name) !== null,
      onLeave: () => stack.pop(),
      onFilePicked: (entry: DirectoryEntry, pickCtx) => {
        if (!fileKind(entry.name)) {
          notice = "Pick a .md, .txt or .abc file";
          return;
        }
        pickCtx.stack.pop();
        openFile(pickCtx, entry.path, entry.name);
      },
    });
    stack.push(picker);
  };

  function refreshHome(): void {
    const font = getDefaultSmallFont();
    const items: MenuItem[] = [
      { label: "Browse for a file...", onSelect: (ctx) => openBrowser(ctx) },
      { label: SAMPLE_NAME, onSelect: (ctx) => openSample(ctx) },
    ];
    for (const recent of getRecentFiles()) {
      const folder = parentDirName(recent.path);
      items.push({
        label: recent.name || baseName(recent.path),
        onSelect: (ctx) => openFile(ctx, recent.path, recent.name),
        render: ({ image, x, y, width, selected, text }) => {
          const value = selected ? 255 : 200;
          const folderWidth = folder ? font.measureText(folder) : 0;
          const nameMax = folder ? width - folderWidth - 12 : width;
          image.drawText(font, x, y + LIST_ROW_TEXT_INSET, truncateText(font, text, Math.max(40, nameMax)), value);
          if (folder && nameMax >= 40) {
            image.drawText(font, x + width - folderWidth, y + LIST_ROW_TEXT_INSET, folder, 90);
          }
        },
      });
    }
    if (notice) items.push({ label: notice, disabled: true, onSelect: () => {} });
    homeItems.length = 0;
    homeItems.push(...items);
    // Land on the most recent file (one click resumes it), else on Browse.
    home.selectItem(getRecentFiles().length > 0 ? 2 : 0);
  }

  refreshHome();

  created = createInProcessWindow({
    appId: "muse",
    windowId: MUSE_WINDOW_ID,
    title: "Muse",
    iconLetter: "M",
    icon: "music",
    closeable: true,
    heightMode: "max",
    actions: options.actions,
    menuItems: () => {
      const top = topLayer();
      if (top instanceof MuseReaderLayer) return top.buildMenuItems();
      if (top instanceof FileBrowserLayer) return top.buildMenuItems();
      if (top !== home) return [];
      return [
        {
          label: "Clear recent files",
          onSelect: (ctx) => {
            clearRecentFiles();
            refreshHome();
            ctx.stack.pop();
          },
        },
      ];
    },
    onFocus: (lastInput) => {
      const top = topLayer();
      if (top instanceof FileBrowserLayer) top.onFocus(lastInput);
    },
    baseLayer: new YieldAtRootLayer(home),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    reconfigureSurface: options.reconfigureSurface,
    onClosed: options.onClosed,
  });
  return created;
}

import { GrayImage, imageFromAsciiArt, type UiFont } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { EditTextSettingLayer, enumSettingMenuItem, textSettingMenuItem } from "../../ui/dashboard-settings";
import {
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_SCROLL,
  GESTURE_SHORT_THEN_LONG_PRESS,
  gestureHints,
  type InputEvent,
} from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { MenuLayer, drawRightValueMenuItem, drawSelectionHighlight, type MenuItem } from "../../ui/menu";
import { lineStep } from "../../ui/metrics";
import { appViewportSize } from "../../ui/shell/geometry";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { formatRelativeTime } from "../../util/date-util";
import type { CueContext } from "./contexts";
import { cueSession, type CueCaption, type CueState, type CueVoice } from "./cue-session";
import { cueBackendTokenSetting, cueBackendUrlSetting, cueEmailsSetting, cueNewPersonSetting, cueOrgSetting, cueTermuxCommandSetting, cueWorkCalendarSetting } from "./cue-settings";
import { cueLink } from "./cue-link";
import { EntryPopupLayer } from "./entry-layer";
import { ENTRY_ICONS, cueLine, dropTime, entryRows, idleNotebookNames, statusEntries, type EntryOption, type EntryRow, type Notebook, type NotebookEntry } from "./notebook-view";

export const CUE_WINDOW_ID = "cue";
export const CUE_SURFACE_ID = "window:cue";

const TRAY_ICON_ID = "cue";

// 14x10 speech-bubble glyph for the top-bar tray; dimmed while not listening.
const TRAY_ROWS = [
  " ############ ",
  "#            #",
  "#  ##  ## ## #",
  "#            #",
  "#  ####  ##  #",
  "#            #",
  " #####  ##### ",
  "     # #      ",
  "     ##       ",
  "     #        ",
];
const TRAY_ICON = imageFromAsciiArt(TRAY_ROWS, 220);
const TRAY_ICON_DIM = imageFromAsciiArt(TRAY_ROWS, 90);

const MENU_LAYOUT = {
  x: 8,
  y: 8,
  width: 292,
  showBorder: false,
  minHeight: 0,
  maxHeight: appViewportSize("min").height - 16,
  opaque: true,
};

function clockTime(ms: number): string {
  const date = new Date(ms);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The context half of the top line: the meeting, the team, or "ad-hoc". */
function contextLabel(context: CueContext): string {
  if (context.event) return context.event.title || "Untitled event";
  if (context.team) return context.team.name;
  return "ad-hoc";
}

function pushLayer(ctx: LayerContext, layer: Layer & { start?(requestRender: () => void): void }): void {
  ctx.stack.push(layer);
  layer.start?.(ctx.actions.requestRender);
}

const TELL_ME_MORE: EntryOption = { label: "Tell me more", action: "ask" };

/**
 * Opens an entry's pop-up in Cue's window; the chosen option goes to the
 * backend. A cue from the conversation on now can also be asked about.
 */
function openEntry(ctx: LayerContext, notebook: Notebook, entry: NotebookEntry): void {
  const askable = Boolean(entry.contextId && entry.contextId === cueSession.state().current?.id);
  ctx.stack.push(new EntryPopupLayer(
    cueLink.entryPopup(notebook, entry, askable ? [TELL_ME_MORE] : []),
    (option) => {
      if (option.action !== "ask") return cueLink.act(notebook.name, entry, option);
      cueSession.ask(entry.id, "Tell me more.");
      pushLayer(ctx, new CueAnswerLayer(entry));
    },
    () => ctx.stack.pop(),
  ));
}

type MainRow = { kind: "ask" } | { kind: "note"; row: EntryRow };

/** The notebooks shown: Work on weekdays 8-6, the others combined otherwise. */
function shownNotebooks(): string[] {
  return idleNotebookNames(cueLink.notebooks, Date.now());
}

/**
 * Cue's main view, in a conversation or not: the notebooks' urgent, todo
 * and status entries, notifications and cues alike. In a conversation, the
 * top line says who's talking and in which context, its cues come first,
 * and while "Meeting over early?" is up that's the first row (a click on it
 * ends the meeting). Then the shown notebooks' open entries, and a line for
 * the status messages. Scroll selects, a click opens.
 */
class CueMainLayer implements Layer {
  private state: CueState = cueSession.state();
  private unsubscribe: (() => void) | null = null;
  private selected = 0;

  start(requestRender: () => void): void {
    this.unsubscribe = cueSession.onState((state) => {
      this.state = state;
      requestRender();
    });
  }

  /** Selectable rows: the question when it's up, then the entries. */
  private rows(): MainRow[] {
    return [
      ...(this.state.askingEnded ? [{ kind: "ask" as const }] : []),
      ...entryRows(cueLink.notebooks, shownNotebooks(), this.state.current?.id ?? null).map((row) => ({ kind: "note" as const, row })),
    ];
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const state = this.state;
    const step = lineStep(font) + 1;
    const rowHeight = step + 3;
    const textWidth = width - 24;
    let y = 4;

    const current = state.current;
    const shown = shownNotebooks();
    const labels = cueLink.notebooks.filter((notebook) => shown.includes(notebook.name)).map((notebook) => notebook.label);
    const top = current ? [state.talking, contextLabel(current)].filter(Boolean).join(" · ") : `Cue${labels.length ? ` · ${labels.join(", ")}` : ""}`;
    image.drawText(font, 12, y, truncateText(font, top, textWidth), 235);
    y += step + 2;

    const handOff = cueLink.recordings.status().detail;
    const problem = !state.listening ? state.status : state.backend !== "connected" ? state.backendDetail : handOff.startsWith("Couldn't") ? handOff : "";
    if (problem) {
      image.drawText(font, 12, y, truncateText(font, problem, textWidth), 120);
      y += step;
    }

    const rows = this.rows();
    this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
    const footerY = height - font.lineHeight - 4;
    const visible = Math.max(1, Math.floor((footerY - y - 2) / rowHeight));
    const first = Math.max(0, Math.min(this.selected - visible + 1, rows.length - visible));
    rows.slice(first, first + visible).forEach((row, index) => {
      const rowY = y + index * rowHeight;
      const selected = first + index === this.selected;
      if (selected) drawSelectionHighlight(image, 8, rowY - 2, width - 16, rowHeight, true, 4);
      const text = row.kind === "ask" ? `Meeting over early?   ${GESTURE_CLICK} end it` : row.row.text;
      const dim = row.kind === "note" && (row.row.kind === "status" || row.row.entry.category === "status");
      const value = selected ? 255 : row.kind === "ask" ? 235 : dim ? 140 : 200;
      image.drawText(font, 12, rowY, truncateText(font, text, textWidth), value);
    });
    if (!rows.length) {
      const body = !cueLink.notebooks.length
        ? state.backend === "connected" ? "Loading the notebooks..." : "Cues and messages appear once Cue's backend is reachable."
        : current ? "No cues yet." : "Nothing in the notebooks. Talking starts a conversation: the meeting on now, or an ad-hoc chat.";
      for (const line of wrapText(font, body, textWidth)) {
        image.drawText(font, 12, y, line, 150);
        y += step;
      }
    }
    if (state.paused.length && rows.length < visible) {
      const paused = state.paused.map((context) => contextLabel(context)).join(", ");
      image.drawText(font, 12, footerY - step, truncateText(font, `Paused: ${paused}`, textWidth), 110);
    }

    const footer = gestureHints([[GESTURE_SCROLL, "select"], [GESTURE_CLICK, "open"], [GESTURE_SHORT_THEN_LONG_PRESS, "menu"]]);
    image.drawText(font, 12, footerY, footer, 110);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    const rows = this.rows();
    if (event.type === "scroll-up") this.selected = Math.max(0, this.selected - 1);
    else if (event.type === "scroll-down") this.selected = Math.min(Math.max(0, rows.length - 1), this.selected + 1);
    else if (event.type === "click") {
      const row = rows[this.selected];
      if (row?.kind === "ask") cueSession.endCurrent();
      else if (row?.kind === "note") {
        if (row.row.kind === "entry") openEntry(ctx, row.row.notebook, row.row.entry);
        else {
          const names = shownNotebooks();
          pushLayer(ctx, new NotebookListLayer("Status messages", () => statusRows(names)));
        }
      }
    }
  }

  onRemoved(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/**
 * Tell me more about a cue: its line and detail, then what you asked about
 * it and the answers as they stream in. A click asks for more.
 */
class CueAnswerLayer implements Layer {
  private state: CueState = cueSession.state();
  private unsubscribe: (() => void) | null = null;
  private scroll = Number.MAX_SAFE_INTEGER;

  constructor(private entry: NotebookEntry) {}

  start(requestRender: () => void): void {
    this.unsubscribe = cueSession.onState((state) => {
      this.state = state;
      requestRender();
    });
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const step = lineStep(font) + 1;
    const textWidth = width - 24;
    const latest = cueLink.notebooks.flatMap((notebook) => [...notebook.entries, ...notebook.status]).find((entry) => entry.id === this.entry.id);
    this.entry = latest ?? this.entry;
    const rows: { text: string; value: number }[] = [];
    const icon = this.entry.category ? `${ENTRY_ICONS[this.entry.category]} ` : "";
    for (const line of wrapText(font, `${icon}${cueLine(this.entry)}`, textWidth)) rows.push({ text: line, value: 245 });
    if (!latest) rows.push({ text: "(No longer in the notebook.)", value: 120 });
    if (this.entry.body) {
      rows.push({ text: "", value: 0 });
      for (const line of wrapText(font, this.entry.body, textWidth)) rows.push({ text: line, value: 200 });
    }
    for (const answer of this.state.answers.values()) {
      if (answer.itemId !== this.entry.id) continue;
      rows.push({ text: "", value: 0 });
      rows.push({ text: `You asked: ${answer.question}`, value: 130 });
      for (const line of wrapText(font, answer.text || "...", textWidth)) rows.push({ text: line, value: answer.done ? 220 : 170 });
    }
    const footerY = height - font.lineHeight - 4;
    const visible = Math.max(1, Math.floor((footerY - 6) / step));
    this.scroll = Math.max(0, Math.min(this.scroll, rows.length - visible));
    rows.slice(this.scroll, this.scroll + visible).forEach((row, index) => image.drawText(font, 12, 4 + index * step, row.text, row.value));
    const footer = gestureHints([[GESTURE_CLICK, "ask more"], [GESTURE_SCROLL, "scroll"], [GESTURE_DOUBLE_CLICK, "back"]]);
    image.drawText(font, 12, footerY, footer, 110);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "scroll-up") this.scroll = Math.max(0, this.scroll - 1);
    else if (event.type === "scroll-down") this.scroll += 1;
    else if (event.type === "double-click") ctx.stack.pop();
    else if (event.type === "click") {
      cueSession.ask(this.entry.id, "Tell me more.");
      this.scroll = Number.MAX_SAFE_INTEGER;
    }
  }

  onRemoved(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

type ListRow = { text: string; value?: number; open: (ctx: LayerContext) => void };

/** The status messages of some notebooks, with Dismiss all first. */
function statusRows(names: string[]): ListRow[] {
  const entries = statusEntries(cueLink.notebooks, names);
  if (!entries.length) return [{ text: "No status messages.", value: 120, open: () => {} }];
  return [
    { text: "Dismiss all", value: 235, open: (ctx) => { cueLink.clearStatus(names); ctx.stack.pop(); } },
    ...entries.map(({ notebook, entry }) => ({
      text: `${ENTRY_ICONS.status} ${names.length > 1 ? `${notebook.label}: ` : ""}${dropTime(entry.text)}`,
      open: (ctx: LayerContext) => openEntry(ctx, notebook, entry),
    })),
  ];
}

/** One notebook's entries and its status line. */
function notebookRows(name: string): ListRow[] {
  const rows = entryRows(cueLink.notebooks, [name]).map((row): ListRow => row.kind === "entry"
    ? { text: row.text, open: (ctx) => openEntry(ctx, row.notebook, row.entry) }
    : { text: row.text, value: 140, open: (ctx) => pushLayer(ctx, new NotebookListLayer("Status messages", () => statusRows([name]))) });
  return rows.length ? rows : [{ text: "Empty.", value: 120, open: () => {} }];
}

/** A live list (the rows are read again on every paint, so actions show at once); click opens, double-click goes back. */
class NotebookListLayer implements Layer {
  private selected = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly title: string, private readonly rows: () => ListRow[]) {}

  start(requestRender: () => void): void {
    this.unsubscribe = cueLink.onChange(requestRender);
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const step = lineStep(font) + 1;
    const rowHeight = step + 3;
    image.drawText(font, 12, 4, this.title, 235);
    const rows = this.rows();
    this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
    const top = 4 + step + 4;
    const footerY = height - font.lineHeight - 4;
    const visible = Math.max(1, Math.floor((footerY - top - 2) / rowHeight));
    const first = Math.max(0, Math.min(this.selected - visible + 1, rows.length - visible));
    rows.slice(first, first + visible).forEach((row, index) => {
      const y = top + index * rowHeight;
      const selected = first + index === this.selected;
      if (selected) drawSelectionHighlight(image, 8, y - 2, width - 16, rowHeight, true, 4);
      image.drawText(font, 12, y, truncateText(font, row.text, width - 24), selected ? 255 : row.value ?? 200);
    });
    image.drawText(font, 12, footerY, gestureHints([[GESTURE_SCROLL, "select"], [GESTURE_CLICK, "open"], [GESTURE_DOUBLE_CLICK, "back"]]), 110);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    const rows = this.rows();
    if (event.type === "scroll-up") this.selected = Math.max(0, this.selected - 1);
    else if (event.type === "scroll-down") this.selected = Math.min(rows.length - 1, this.selected + 1);
    else if (event.type === "click") rows[this.selected]?.open(ctx);
    else if (event.type === "double-click") ctx.stack.pop();
  }

  onRemoved(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/** Live transcript with speaker labels; scroll reviews, new speech snaps back to live. */
class CueCaptionsLayer implements Layer {
  private captions: CueCaption[] = cueSession.state().captions;
  private unsubscribe: (() => void) | null = null;
  private scrollback = 0;

  start(requestRender: () => void): void {
    this.unsubscribe = cueSession.onState((state) => {
      if (state.captions.length !== this.captions.length) this.scrollback = 0;
      this.captions = state.captions;
      requestRender();
    });
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    image.drawText(font, 12, 4, "Captions", 220);
    const rows = captionRows(font, width - 36, this.captions);
    const step = lineStep(font) + 1;
    const bodyTop = 24;
    const footerY = height - font.lineHeight - 4;
    const visible = Math.max(1, Math.floor((footerY - bodyTop) / step));
    this.scrollback = Math.min(this.scrollback, Math.max(0, rows.length - visible));
    const first = Math.max(0, rows.length - visible - this.scrollback);
    rows.slice(first, first + visible).forEach((row, index) => {
      const y = bodyTop + index * step;
      if (row.prefix) image.drawText(font, 16, y, row.prefix, 170);
      image.drawText(font, 16 + row.indent, y, row.text, row.value);
    });
    if (!rows.length) image.drawText(font, 16, bodyTop, "Nothing heard yet.", 130);
    image.drawText(font, 12, footerY, gestureHints([[GESTURE_SCROLL, "history"], [GESTURE_DOUBLE_CLICK, "back"]]), 110);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "scroll-up") this.scrollback += 1;
    else if (event.type === "scroll-down") this.scrollback = Math.max(0, this.scrollback - 1);
    else if (event.type === "double-click") ctx.stack.pop();
  }

  onRemoved(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

function captionRows(font: UiFont, maxWidth: number, captions: CueCaption[]) {
  const rows: { prefix: string; text: string; value: number; indent: number }[] = [];
  for (const caption of captions) {
    const prefix = caption.speaker ? `${caption.speaker}: ` : "";
    const indent = font.measureText(prefix);
    wrapText(font, caption.text, maxWidth - indent).forEach((text, index) => {
      rows.push({ prefix: index === 0 ? prefix : "", text, value: caption.final ? 230 : 150, indent });
    });
  }
  return rows;
}

/** "Priya" when confirmed, "Priya?" when the backend isn't sure, else "Voice 2". */
function voiceName(voice: CueVoice): string {
  if (!voice.name) return voice.label;
  return voice.confirmed ? voice.name : `${voice.name}?`;
}

/**
 * Current People: the voices heard in the context, then its invitees and
 * chosen people. Clicking "Dana?" confirms it; clicking any other voice
 * asks who it is.
 */
function peopleMenu(state: CueState): MenuLayer {
  const items: MenuItem[] = [];
  for (const voice of state.voices) {
    const name = voiceName(voice);
    const unsure = Boolean(voice.name && !voice.confirmed && voice.personId);
    items.push({
      label: name,
      onSelect: (ctx) => {
        if (unsure) {
          cueSession.nameVoice(voice.label, voice.personId!, voice.name);
          ctx.stack.pop();
        } else {
          ctx.stack.push(whoMenu(voice.label, name));
        }
      },
      render: ({ image, x, y, width }) => drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, name,
        unsure ? `${GESTURE_CLICK} confirm` : `${formatRelativeTime(voice.lastHeardMs)} ago`),
    });
  }
  const current = state.current;
  for (const person of current?.people ?? []) items.push(infoItem(person.name, "chosen"));
  for (const attendee of current?.event?.attendees ?? []) {
    if (attendee.type === "resource") continue;
    items.push(infoItem(attendee.name || attendee.email, attendee.type === "optional" ? "optional" : "invited"));
  }
  if (!items.length) items.push({ label: current ? "No one heard yet" : "Not in a conversation", disabled: true, onSelect: () => {} });
  return new MenuLayer("People", items, MENU_LAYOUT);
}

function infoItem(label: string, value: string): MenuItem {
  return {
    label,
    onSelect: () => {},
    render: ({ image, x, y, width }) => drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, label, value),
  };
}

/**
 * Who's this?: you, the context's candidates (here, team, org), people
 * from this week, or someone new, whose name is typed on the phone. The
 * choice names the voice and trains its voice-print.
 */
function whoMenu(label: string, shown: string): MenuLayer {
  const items: MenuItem[] = cueSession.whoChoices().map((choice) => ({
    label: choice.name,
    onSelect: (ctx: LayerContext) => {
      cueSession.nameVoice(label, choice.personId, choice.name);
      ctx.stack.clearToBase();
    },
    render: ({ image, x, y, width }) => drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, choice.name, choice.hint),
  }));
  items.push({
    label: "Someone new",
    onSelect: (ctx) => {
      cueSession.nameNewVoice(label);
      void ctx.actions.startTextSettingEdit(cueNewPersonSetting);
      ctx.stack.push(new EditTextSettingLayer(cueNewPersonSetting));
    },
  });
  return new MenuLayer(`Who's ${shown}?`, items, MENU_LAYOUT);
}

function switchMenu(): MenuLayer {
  const choices = cueSession.switchChoices(clockTime);
  const items: MenuItem[] = choices.length
    ? choices.map((choice) => ({
        label: choice.label,
        onSelect: (ctx) => {
          cueSession.switchTo(choice.target);
          ctx.stack.clearToBase();
        },
      }))
    : [{ label: "No meeting on now, nothing paused", disabled: true, onSelect: () => {} }];
  return new MenuLayer("Switch", items, MENU_LAYOUT);
}

function menuItems(): MenuItem[] {
  return [
    { label: "Switch", onSelect: (ctx) => ctx.stack.push(switchMenu()) },
    {
      label: "New conversation",
      onSelect: (ctx) => {
        cueSession.switchTo({ type: "new" });
        ctx.stack.clearToBase();
      },
    },
    {
      label: "Captions",
      onSelect: (ctx) => {
        const layer = new CueCaptionsLayer();
        ctx.stack.push(layer);
        layer.start(ctx.actions.requestRender);
      },
    },
    { label: "People", onSelect: (ctx) => ctx.stack.push(peopleMenu(cueSession.state())) },
    {
      label: "Who's this?",
      disabled: () => !cueSession.state().talkingLabel,
      onSelect: (ctx) => {
        const state = cueSession.state();
        ctx.stack.push(whoMenu(state.talkingLabel, state.talking));
      },
    },
    {
      label: "Notebooks",
      onSelect: (ctx) => ctx.stack.push(new MenuLayer(
        "Notebooks",
        (cueLink.notebooks.length ? cueLink.notebooks : []).map((notebook): MenuItem => ({
          label: notebook.label,
          onSelect: (inner) => pushLayer(inner, new NotebookListLayer(notebook.label, () => notebookRows(notebook.name))),
          render: ({ image, x, y, width }) => drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, notebook.label, `${notebook.entries.length} · ${notebook.statusCount} status`),
        })).concat(cueLink.notebooks.length ? [] : [{ label: "Not loaded yet", disabled: true, onSelect: () => {} }]),
        MENU_LAYOUT,
      )),
    },
    {
      label: "Undo last memory update",
      disabled: () => !cueLink.lastMemoryUpdate,
      onSelect: (ctx) => {
        cueLink.undoMemoryUpdate();
        ctx.stack.clearToBase();
      },
    },
    {
      label: "End conversation",
      disabled: () => !cueSession.state().current,
      onSelect: (ctx) => {
        cueSession.endCurrent();
        ctx.stack.clearToBase();
      },
    },
    {
      label: "Settings",
      onSelect: (ctx) =>
        ctx.stack.push(
          new MenuLayer(
            "Cue settings",
            [
              textSettingMenuItem(cueEmailsSetting),
              enumSettingMenuItem(cueOrgSetting),
              textSettingMenuItem(cueWorkCalendarSetting),
              textSettingMenuItem(cueBackendUrlSetting),
              textSettingMenuItem(cueBackendTokenSetting),
              textSettingMenuItem(cueTermuxCommandSetting),
            ],
            MENU_LAYOUT,
          ),
        ),
    },
  ];
}

/**
 * The Cue window. While it's open Cue listens, whichever app is in front;
 * closing it stops Cue, which ends every context so all of it is kept.
 */
export function createCueAppWindow(options: InProcessAppOptions): InProcessWindow {
  const layer = new CueMainLayer();
  // Bright while Cue listens and reaches its backend; dim otherwise.
  let healthy: boolean | null = null;
  const unsubscribeTray = cueSession.onState((state) => {
    const now = state.listening && state.backend === "connected";
    if (now === healthy) return;
    healthy = now;
    shell.setTrayIcon(TRAY_ICON_ID, healthy ? TRAY_ICON : TRAY_ICON_DIM);
  });
  const app = createInProcessWindow({
    appId: "cue",
    windowId: CUE_WINDOW_ID,
    title: "Cue",
    iconLetter: "Cu",
    icon: "message-circle",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(layer),
    menuItems,
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      layer.onRemoved();
      unsubscribeTray();
      cueSession.stop();
      shell.setTrayIcon(TRAY_ICON_ID, null);
      options.onClosed();
    },
  });
  layer.start(app.requestRender);
  cueSession.start(options.actions);
  return app;
}

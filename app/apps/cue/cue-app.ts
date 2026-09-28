import { GrayImage, imageFromAsciiArt, type UiFont } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { textSettingMenuItem } from "../../ui/dashboard-settings";
import {
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_SCROLL,
  GESTURE_SHORT_THEN_LONG_PRESS,
  gestureHints,
  type InputEvent,
} from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { MenuLayer, drawRightValueMenuItem, type MenuItem } from "../../ui/menu";
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
import { cueSession, type CueCaption, type CueState } from "./cue-session";
import { cueEmailsSetting } from "./cue-settings";

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

/**
 * Cue's main view: who's talking and in which context, then the cues for it.
 * Cues come from the backend (not connected yet), so for now the body says
 * what Cue is doing. A click answers "Meeting over early?".
 */
class CueMainLayer implements Layer {
  private state: CueState = cueSession.state();
  private unsubscribe: (() => void) | null = null;

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
    const state = this.state;
    const step = lineStep(font) + 1;
    const textWidth = width - 24;
    let y = 4;

    const current = state.current;
    const top = current ? [state.talking, contextLabel(current)].filter(Boolean).join(" · ") : "Cue";
    image.drawText(font, 12, y, truncateText(font, top, textWidth), 235);
    y += step + 2;

    if (!state.listening) {
      image.drawText(font, 12, y, truncateText(font, state.status, textWidth), 120);
      y += step;
    }
    if (state.askingEnded) {
      image.fillRoundedRect(8, y - 2, width - 16, step + 2, 60, 3);
      image.drawText(font, 12, y, truncateText(font, `Meeting over early?   ${GESTURE_CLICK} end it`, textWidth), 255);
      y += step + 4;
    }

    const body = current
      ? "No cues yet: they need Cue's backend, which isn't connected."
      : "Not in a conversation. Talking starts one: the meeting on now, or an ad-hoc chat.";
    for (const line of wrapText(font, body, textWidth)) {
      image.drawText(font, 12, y, line, 150);
      y += step;
    }
    if (state.paused.length) {
      const paused = state.paused.map((context) => contextLabel(context)).join(", ");
      image.drawText(font, 12, y + 2, truncateText(font, `Paused: ${paused}`, textWidth), 120);
    }

    const footer = gestureHints([[GESTURE_SHORT_THEN_LONG_PRESS, "menu"], [GESTURE_DOUBLE_CLICK, "back"]]);
    image.drawText(font, 12, height - font.lineHeight - 4, footer, 110);
    return image;
  }

  handleInput(event: InputEvent): void {
    if (event.type === "click" && this.state.askingEnded) cueSession.endCurrent();
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

/** Current People: the context's invitees and chosen people, and the voices heard in it. */
function peopleMenu(state: CueState): MenuLayer {
  const items: MenuItem[] = [];
  for (const voice of state.voices) {
    items.push(infoItem(voice.label, `${formatRelativeTime(voice.lastHeardMs)} ago`));
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
      label: "End conversation",
      disabled: () => !cueSession.state().current,
      onSelect: (ctx) => {
        cueSession.endCurrent();
        ctx.stack.clearToBase();
      },
    },
    textSettingMenuItem(cueEmailsSetting),
  ];
}

/**
 * The Cue window. While it's open Cue listens, whichever app is in front;
 * closing it stops Cue, which ends every context so all of it is kept.
 */
export function createCueAppWindow(options: InProcessAppOptions): InProcessWindow {
  const layer = new CueMainLayer();
  let listening: boolean | null = null;
  const unsubscribeTray = cueSession.onState((state) => {
    if (state.listening === listening) return;
    listening = state.listening;
    shell.setTrayIcon(TRAY_ICON_ID, listening ? TRAY_ICON : TRAY_ICON_DIM);
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

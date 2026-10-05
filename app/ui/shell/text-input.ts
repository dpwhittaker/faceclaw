import { type GrayImage, type UiFont } from "../../graphics/image";
import { truncateLeft, truncateText, wrapText } from "../../graphics/textwrap";
import { getDefaultLargeFont, getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import {
  GESTURE_CLICK,
  GESTURE_DOUBLE_CLICK,
  GESTURE_LONG_PRESS,
  GESTURE_SCROLL_DOWN,
  GESTURE_SCROLL_UP,
  GESTURE_SHORT_THEN_LONG_PRESS,
  gestureHints,
  type InputEvent,
} from "../gestures";
import { Layer, type LayerActions, type LayerContext } from "../layers";
import { drawSelectionHighlight } from "../menu";
import { inputDialogRect, paintInputDialog, paintInputDialogBox } from "./input-dialog";
import {
  capitalOf,
  firstKeys,
  type KeyboardOutcome,
  type KeyNode,
  nodeDepth,
  SLOT_BOTTOM,
  SLOT_MIDDLE,
  SLOT_TOP,
  TrinaryKeyboard,
} from "./trinary-keyboard";
import { type VoiceSendTarget } from "./voice-input";

export type TextInputLayerOptions = {
  actions: LayerActions;
  /** Post-removal cleanup (also fires when the screen turns off). */
  onClosed: () => void;
  /** Pop this layer off the shell stack. */
  dismiss: () => void;
  /** Ordered send destinations shown as the first menu rows. */
  sendTargets: VoiceSendTarget[];
  /** Which send target is highlighted by default (entry-point dependent). */
  defaultTargetIndex?: number;
};

// The three key boxes stack down the dialog's right edge, with the gesture
// that enters each one drawn to its left; the message fills the rest.
const BOX_WIDTH = 150;
const BOX_GAP = 8;
const BOX_INSET = 10;
const GESTURE_COLUMN = 22;
const TEXT_INSET = 16;
const BOX_GESTURES = [GESTURE_SCROLL_UP, GESTURE_CLICK, GESTURE_SCROLL_DOWN] as const;

// Key brightness: the middle column (the keys a tap types) stands out.
const KEY_TAP = 255;
const KEY_OTHER = 175;

/**
 * One swipe on the R1 can arrive as two to four swipe reports 60-130 ms apart
 * with no new touch between them, while two deliberate swipes (each needing a
 * touch of its own) were never closer than 510 ms. Each extra report would zoom
 * one more level, so swipes this close to the previous one are dropped.
 */
const SWIPE_REPEAT_MS = 250;

/** Tabs have no glyph; show them as the Tab key's label. */
function displayText(text: string): string {
  return text.replace(/\t/g, "↦");
}

/**
 * The ring keyboard ("Text input" in the system menu): types a message with
 * the ring alone, no phone or microphone. The keyboard is a three-way tree
 * (see trinary-keyboard.ts) drawn as three boxes — swipe up zooms into the
 * top one, swipe down the bottom one, tap the middle one or types it when it
 * is a single key; long-press types that key as a capital; double-tap zooms
 * out; tap-then-hold deletes the last character. Double-tap at the outermost
 * level shows the same send / discard menu as the voice and phone keyboard
 * dialogs, plus Keep typing; double-tap there (or Keep typing) returns to the
 * keyboard, so a stray double-tap never throws away what was typed.
 *
 * Long-press and tap-then-hold reach this layer only because it claims them
 * (acceptsHoldGestures); over every other overlay the shell keeps them.
 */
export class TextInputLayer implements Layer {
  readonly acceptsHoldGestures = true;
  private readonly keyboard = new TrinaryKeyboard();
  private text = "";
  private phase: "keyboard" | "menu" = "keyboard";
  private menuIndex: number;
  /** When the last swipe was taken (see SWIPE_REPEAT_MS). */
  private lastSwipeAtMs = -Infinity;

  private readonly actions: LayerActions;
  private readonly onClosed: () => void;
  private readonly dismiss: () => void;
  private readonly sendTargets: VoiceSendTarget[];
  private readonly defaultTargetIndex: number;

  constructor(options: TextInputLayerOptions) {
    this.actions = options.actions;
    this.onClosed = options.onClosed;
    this.dismiss = options.dismiss;
    this.sendTargets = options.sendTargets;
    const defaultIndex = options.defaultTargetIndex ?? 0;
    this.defaultTargetIndex = Math.min(Math.max(0, defaultIndex), Math.max(0, this.sendTargets.length - 1));
    this.menuIndex = this.defaultTargetIndex;
  }

  /** The message typed so far. */
  getText(): string {
    return this.text;
  }

  handleInput(event: InputEvent, _ctx: LayerContext): void {
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      if (event.timestampMs - this.lastSwipeAtMs < SWIPE_REPEAT_MS) return;
      this.lastSwipeAtMs = event.timestampMs;
    }
    if (this.phase === "menu") {
      this.handleMenuInput(event);
      return;
    }
    switch (event.type) {
      case "scroll-up":
        this.apply(this.keyboard.zoom(SLOT_TOP));
        return;
      case "scroll-down":
        this.apply(this.keyboard.zoom(SLOT_BOTTOM));
        return;
      case "click":
        this.apply(this.keyboard.tap());
        return;
      case "long-press":
        this.apply(this.keyboard.tap(true));
        return;
      case "short-then-long-press":
        this.deleteLast();
        return;
      case "double-click":
        if (!this.keyboard.back()) {
          this.phase = "menu";
          this.menuIndex = this.defaultTargetIndex;
        }
        this.actions.requestRender();
        return;
      default:
        return;
    }
  }

  private apply(outcome: KeyboardOutcome): void {
    if (outcome.kind === "none") return;
    if (outcome.kind === "typed") this.text += outcome.text;
    this.actions.requestRender();
  }

  private deleteLast(): void {
    if (!this.text) return;
    // By code point, so a character outside the BMP goes in one press.
    const chars = Array.from(this.text);
    chars.pop();
    this.text = chars.join("");
    this.actions.requestRender();
  }

  /** Back from the menu to the keyboard, at the letters. */
  private keepTyping(): void {
    this.phase = "keyboard";
    this.keyboard.reset();
    this.actions.requestRender();
  }

  /** The menu rows: one per send target, then Keep typing, then Discard. */
  private menuRows(): Array<{ label: string; dim: boolean; onSelect: () => void }> {
    const text = this.text.trim();
    const rows: Array<{ label: string; dim: boolean; onSelect: () => void }> = [];
    for (const target of this.sendTargets) {
      rows.push({
        label: target.label,
        dim: !text,
        onSelect: () => {
          // An empty message has nothing to deliver; the row is drawn dim.
          if (!text) return;
          this.dismiss();
          target.onSend(text);
        },
      });
    }
    rows.push({ label: "Keep typing", dim: false, onSelect: () => this.keepTyping() });
    rows.push({ label: "Discard", dim: false, onSelect: () => this.dismiss() });
    return rows;
  }

  private handleMenuInput(event: InputEvent): void {
    const rowCount = this.menuRows().length;
    switch (event.type) {
      case "scroll-up":
        this.menuIndex = (this.menuIndex + rowCount - 1) % rowCount;
        this.actions.requestRender();
        return;
      case "scroll-down":
        this.menuIndex = (this.menuIndex + 1) % rowCount;
        this.actions.requestRender();
        return;
      case "click":
        this.menuRows()[this.menuIndex]?.onSelect();
        return;
      case "double-click":
        this.keepTyping();
        return;
      default:
        return;
    }
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = paintBelow();
    if (this.phase === "menu") {
      paintInputDialog(image, {
        title: "Text",
        status: "Send, keep typing, or discard?",
        text: displayText(this.text) || "(nothing typed yet)",
        rows: this.menuRows(),
        selectedRow: this.menuIndex,
      });
      return image;
    }
    this.paintKeyboard(image);
    return image;
  }

  private paintKeyboard(image: GrayImage): void {
    paintInputDialogBox(image);
    const rect = inputDialogRect();
    const font = getDefaultSmallFont();
    const boxX = rect.x + rect.width - BOX_INSET - BOX_WIDTH;
    const left = rect.x + TEXT_INSET;
    const textWidth = boxX - GESTURE_COLUMN - 8 - left;

    image.drawText(font, left, rect.y + 12, "Text", 220);
    const trail = this.keyboard.isAtRoot() ? "All characters" : this.keyboard.trail().join(" › ");
    image.drawText(font, left, rect.y + 30, truncateLeft(font, trail, textWidth), 130);

    const hintY = rect.y + rect.height - font.lineHeight - 8;
    this.paintMessage(image, font, left, rect.y + 56, textWidth, hintY - 6);
    image.drawText(font, left, hintY, truncateText(font, this.hintText(), textWidth), 120);

    const boxHeight = Math.floor((rect.height - 2 * BOX_INSET - 2 * BOX_GAP) / 3);
    const current = this.keyboard.current();
    const view: ReadonlyArray<KeyNode | null> = current.kind === "key" ? [null, current, null] : current.children;
    for (let slot = SLOT_TOP; slot <= SLOT_BOTTOM; slot++) {
      const node = view[slot] ?? null;
      const y = rect.y + BOX_INSET + slot * (boxHeight + BOX_GAP);
      if (!node) {
        // A group with an empty slot keeps its outline so the three boxes
        // stay put; a single key in view shows only its own box.
        if (current.kind === "group") image.drawRoundedRect(boxX, y, BOX_WIDTH, boxHeight, 35, 8);
        continue;
      }
      if (slot === SLOT_MIDDLE) {
        drawSelectionHighlight(image, boxX, y, BOX_WIDTH, boxHeight, true, 8);
      } else {
        image.drawRoundedRect(boxX, y, BOX_WIDTH, boxHeight, 110, 8);
      }
      const gesture = BOX_GESTURES[slot]!;
      drawCentered(image, font, gesture, boxX - GESTURE_COLUMN / 2 - 4, y + ((boxHeight - font.lineHeight) >> 1), 120);
      paintNode(image, node, boxX, y, BOX_WIDTH, boxHeight);
    }
  }

  /** The message, its tail in view, with a cursor after the last character. */
  private paintMessage(image: GrayImage, font: UiFont, left: number, top: number, width: number, bottom: number): void {
    const lineHeight = Math.max(16, font.lineHeight);
    const maxLines = Math.max(1, Math.floor((bottom - top) / lineHeight));
    // A stand-in character holds the cursor's place through wrapping, so a
    // trailing space or newline moves the cursor as it should.
    const lines = wrapText(font, `${displayText(this.text)}|`, width, { breakLongWords: true });
    const first = Math.max(0, lines.length - maxLines);
    for (let index = first; index < lines.length; index++) {
      const y = top + (index - first) * lineHeight;
      let line = lines[index]!;
      if (index === lines.length - 1) {
        line = line.slice(0, -1);
        const cursorX = Math.round(left + font.measureText(line)) + 1;
        image.fillRect(cursorX, y + 1, 2, font.lineHeight - 2, 200);
      }
      image.drawText(font, left, y, line, 235);
    }
  }

  private hintText(): string {
    const hints: Array<[string, string]> = [];
    const leaf = this.keyboard.tapKey();
    if (this.keyboard.current().kind === "key") hints.push([GESTURE_CLICK, "type"]);
    hints.push([GESTURE_DOUBLE_CLICK, this.keyboard.isAtRoot() ? "finish" : "back"]);
    if (leaf && capitalOf(leaf) !== leaf.text) hints.push([GESTURE_LONG_PRESS, "capital"]);
    if (this.text) hints.push([GESTURE_SHORT_THEN_LONG_PRESS, "delete"]);
    return gestureHints(hints);
  }

  onRemoved(): void {
    this.onClosed();
  }
}

function drawCentered(image: GrayImage, font: UiFont, text: string, centerX: number, y: number, value: number): void {
  image.drawText(font, Math.round(centerX - font.measureText(text) / 2), y, text, value);
}

/**
 * One key: its label, or for space an open-box mark drawn in pixels (the
 * glyph for it is missing from the bitmap fonts).
 */
function drawKey(image: GrayImage, font: UiFont, node: KeyNode, centerX: number, y: number, value: number): void {
  if (node.kind !== "key") return;
  if (node.text !== " ") {
    drawCentered(image, font, node.label ?? node.text, centerX, y, value);
    return;
  }
  const width = Math.max(8, Math.round(font.lineHeight * 0.6));
  const tick = Math.max(3, Math.round(font.lineHeight * 0.2));
  const x = Math.round(centerX - width / 2);
  const baseline = y + font.ascent;
  image.fillRect(x, baseline, width, 1, value);
  image.fillRect(x, baseline - tick, 1, tick, value);
  image.fillRect(x + width - 1, baseline - tick, 1, tick, value);
}

/**
 * What a box shows of its node: a single key large; a row of keys across;
 * up to nine keys as three rows (so the next two moves can be read off the
 * box); anything deeper as sample characters over the group's name.
 */
function paintNode(image: GrayImage, node: KeyNode, x: number, y: number, width: number, height: number): void {
  const centerX = x + width / 2;
  const depth = nodeDepth(node);
  if (node.kind === "key") {
    const font = getDefaultLargeFont();
    drawKey(image, font, node, centerX, y + ((height - font.lineHeight) >> 1), KEY_TAP);
    return;
  }
  if (depth === 1) {
    const font = getDefaultMediumFont();
    const pitch = width / 3.5;
    const rowY = y + ((height - font.lineHeight) >> 1);
    node.children.forEach((child, column) => {
      if (child) drawKey(image, font, child, centerX + (column - 1) * pitch, rowY, column === SLOT_MIDDLE ? KEY_TAP : KEY_OTHER);
    });
    return;
  }
  if (depth === 2) {
    const font = getDefaultSmallFont();
    const pitch = width / 4.5;
    const rowPitch = Math.min(font.lineHeight + 4, (height - 6) / 3);
    const top = y + ((height - 3 * rowPitch) >> 1) + ((rowPitch - font.lineHeight) >> 1);
    node.children.forEach((child, rowIndex) => {
      if (!child) return;
      const rowY = Math.round(top + rowIndex * rowPitch);
      // A lone key in a row sits in the middle column: a tap types it.
      const keys: ReadonlyArray<KeyNode | null> = child.kind === "key" ? [null, child, null] : child.children;
      keys.forEach((keyNode, column) => {
        if (keyNode) drawKey(image, font, keyNode, centerX + (column - 1) * pitch, rowY, column === SLOT_MIDDLE ? KEY_TAP : KEY_OTHER);
      });
    });
    return;
  }
  const small = getDefaultSmallFont();
  const medium = getDefaultMediumFont();
  const preview = node.preview ?? firstKeys(node, 3).map((leaf) => leaf.label ?? leaf.text).join("");
  const label = truncateText(small, node.label ?? "", width - 12);
  const blockHeight = medium.lineHeight + 2 + small.lineHeight;
  const top = y + ((height - blockHeight) >> 1);
  drawCentered(image, medium, truncateText(medium, preview, width - 12), centerX, top, KEY_TAP);
  drawCentered(image, small, label, centerX, top + medium.lineHeight + 2, 150);
}

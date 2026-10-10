import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, gestureHints, type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { drawSelectionHighlight } from "../../ui/menu";
import { lineStep } from "../../ui/metrics";
import { ENTRY_ICONS, type EntryCategory, type EntryOption } from "./notebook-view";

export type EntryPopup = {
  category: EntryCategory | null;
  /** "Ivana Muzaric · email" */
  heading: string;
  /** The message, or a cue's line and detail. */
  body: string;
  /** Read again on every paint, so options that arrive later (suggested replies) show up. */
  readonly options: EntryOption[];
  /** Calls back when the options may have changed; returns the unsubscribe. */
  onChange?: (listener: () => void) => () => void;
};

/** The message gets at least this many lines; past that, the options scroll. */
const MIN_BODY_LINES = 3;

/**
 * One entry or arriving message, with what you can do about it: scroll
 * through the options, click one; Back (the first, selected to start) or a
 * double-click closes and leaves it as it is. Sending one of the
 * notification's responses keeps the pop-up open, saying how it went, with
 * Dismiss selected. Options can change while it's up (Claude's suggested
 * replies arrive a few seconds later); the selection stays on the option it
 * was on, or goes back to Back if that one's gone. Hosted in a shell modal
 * over any app, or in Cue's own window.
 */
export class EntryPopupLayer implements Layer {
  private selected = 0;
  private selectedLabel = "";
  private notice = "";
  private unsubscribe: (() => void) | null = null;

  /** onChoose returns what a response did ("Sent: ..."), which keeps the pop-up open. */
  constructor(
    private readonly popup: EntryPopup,
    private readonly onChoose: (option: EntryOption) => string | void,
    private readonly onClose: () => void,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    if (!this.unsubscribe && this.popup.onChange) this.unsubscribe = this.popup.onChange(() => ctx.actions.requestRender());
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const step = lineStep(font) + 1;
    const rowHeight = step + 3;
    const textWidth = width - 16;
    const icon = this.popup.category ? `${ENTRY_ICONS[this.popup.category]} ` : "";
    image.drawText(font, 8, 2, truncateText(font, `${icon}${this.popup.heading}`, textWidth), 245);

    const options = this.popup.options;
    this.follow(options);
    const footerY = height - font.lineHeight - 2;
    const bodyTop = 4 + step;
    const fit = Math.max(1, Math.floor((footerY - 2 - bodyTop - MIN_BODY_LINES * step) / rowHeight));
    const shown = Math.min(options.length, fit);
    const first = Math.max(0, Math.min(this.selected - shown + 1, options.length - shown));
    const optionsTop = footerY - shown * rowHeight - 2;
    // The message fills what the options leave; a long one ends in "…".
    const bodyRows = Math.max(0, Math.floor((optionsTop - bodyTop) / step));
    const lines = wrapText(font, this.popup.body.replace(/\n{2,}/g, "\n"), textWidth);
    lines.slice(0, bodyRows).forEach((line, index) => {
      const text = index === bodyRows - 1 && lines.length > bodyRows ? truncateText(font, `${line}…`, textWidth) : line;
      image.drawText(font, 8, bodyTop + index * step, text, 200);
    });

    options.slice(first, first + shown).forEach((option, index) => {
      const y = optionsTop + index * rowHeight;
      const selected = first + index === this.selected;
      if (selected) drawSelectionHighlight(image, 4, y - 2, width - 8, rowHeight, true, 4);
      const more = (index === 0 && first > 0) || (index === shown - 1 && first + shown < options.length);
      image.drawText(font, 10, y, truncateText(font, `${option.label}${more ? " …" : ""}`, width - 20), selected ? 255 : 190);
    });
    const footer = this.notice || gestureHints([[GESTURE_SCROLL, "choose"], [GESTURE_CLICK, "select"], [GESTURE_DOUBLE_CLICK, "close"]]);
    image.drawText(font, 8, footerY, truncateText(font, footer, textWidth), this.notice ? 220 : 110);
    return image;
  }

  handleInput(event: InputEvent): void {
    const options = this.popup.options;
    this.follow(options);
    const count = options.length;
    if (event.type === "scroll-up") this.select(options, (this.selected + count - 1) % count);
    else if (event.type === "scroll-down") this.select(options, (this.selected + 1) % count);
    else if (event.type === "click") {
      const option = options[this.selected];
      if (option?.action === "respond") {
        this.notice = this.onChoose(option) || "";
        const dismiss = options.findIndex((candidate) => candidate.action === "dismiss");
        if (dismiss >= 0) this.select(options, dismiss);
        return;
      }
      this.close();
      if (option) this.onChoose(option);
    } else if (event.type === "double-click") this.close();
  }

  onRemoved(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private close(): void {
    this.onRemoved();
    this.onClose();
  }

  private select(options: readonly EntryOption[], index: number): void {
    this.selected = index;
    this.selectedLabel = options[index]?.label ?? "";
  }

  /** Keeps the selection on its option when the options change; Back when it's gone. */
  private follow(options: readonly EntryOption[]): void {
    if (options[this.selected]?.label === this.selectedLabel) return;
    const index = options.findIndex((option) => option.label === this.selectedLabel);
    this.select(options, Math.max(0, index));
  }
}

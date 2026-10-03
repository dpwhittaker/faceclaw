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
  /** The message, or the entry's text for one from a conversation. */
  body: string;
  options: EntryOption[];
};

/**
 * One notebook entry or arriving message, with what you can do about it:
 * scroll through the options, click one; double-click closes and leaves it
 * as it is. Hosted in a shell modal over any app, or in Cue's own window.
 */
export class EntryPopupLayer implements Layer {
  private selected = 0;

  constructor(
    private readonly popup: EntryPopup,
    private readonly onChoose: (option: EntryOption) => void,
    private readonly onClose: () => void,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const step = lineStep(font) + 1;
    const rowHeight = step + 3;
    const textWidth = width - 16;
    const icon = this.popup.category ? `${ENTRY_ICONS[this.popup.category]} ` : "";
    image.drawText(font, 8, 2, truncateText(font, `${icon}${this.popup.heading}`, textWidth), 245);

    const options = this.popup.options;
    const footerY = height - font.lineHeight - 2;
    const optionsTop = footerY - options.length * rowHeight - 2;
    // The message fills what the options leave; a long one ends in "…".
    const bodyRows = Math.max(0, Math.floor((optionsTop - (4 + step)) / step));
    const lines = wrapText(font, this.popup.body.replace(/\n{2,}/g, "\n"), textWidth);
    lines.slice(0, bodyRows).forEach((line, index) => {
      const text = index === bodyRows - 1 && lines.length > bodyRows ? truncateText(font, `${line}…`, textWidth) : line;
      image.drawText(font, 8, 4 + step + index * step, text, 200);
    });

    options.forEach((option, index) => {
      const y = optionsTop + index * rowHeight;
      const selected = index === this.selected;
      if (selected) drawSelectionHighlight(image, 4, y - 2, width - 8, rowHeight, true, 4);
      image.drawText(font, 10, y, option.label, selected ? 255 : 190);
    });
    image.drawText(font, 8, footerY, gestureHints([[GESTURE_SCROLL, "choose"], [GESTURE_CLICK, "select"], [GESTURE_DOUBLE_CLICK, "close"]]), 110);
    return image;
  }

  handleInput(event: InputEvent): void {
    const count = this.popup.options.length;
    if (event.type === "scroll-up") this.selected = (this.selected + count - 1) % count;
    else if (event.type === "scroll-down") this.selected = (this.selected + 1) % count;
    else if (event.type === "click") {
      const option = this.popup.options[this.selected];
      this.onClose();
      if (option) this.onChoose(option);
    } else if (event.type === "double-click") this.onClose();
  }
}

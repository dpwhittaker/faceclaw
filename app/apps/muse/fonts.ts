import { getFont } from "../../graphics/bdffont";
import { type UiFont } from "../../graphics/image";
import { ensurePreinstalledFonts, installedFontPath } from "../../graphics/installed-fonts";
import { TtfFont } from "../../graphics/ttf-font";
import { getUiFontSelection } from "../../graphics/ui-fonts";

const cache = new Map<string, UiFont>();

/** Cache key for the current UI face, so a font change in Settings re-lays the page out. */
export function museFontKey(): string {
  const selection = getUiFontSelection();
  return selection.kind === "ttf" ? `ttf:${selection.file}` : "bitmap";
}

/**
 * Muse's text face at a pixel size: the UI font's TTF face when one is
 * picked, else the nearest Terminus bitmap size (12, 16, 24 or 32).
 */
export function museFont(sizePx: number): UiFont {
  const selection = getUiFontSelection();
  const key = `${museFontKey()}:${sizePx}`;
  const cached = cache.get(key);
  if (cached) return cached;
  let font: UiFont | null = null;
  if (selection.kind === "ttf") {
    ensurePreinstalledFonts();
    font = TtfFont.load(installedFontPath(selection.file), sizePx);
  }
  font ??= getFont(sizePx < 14 ? "terminus12" : sizePx < 20 ? "terminus16" : sizePx < 28 ? "terminus24" : "terminus32");
  cache.set(key, font);
  return font;
}

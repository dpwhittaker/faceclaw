import { type UiFont } from "../../graphics/image";
import { installedFontPath } from "../../graphics/installed-fonts";
import { TtfFont } from "../../graphics/ttf-font";
import { getDefaultSmallFont, getUiFontSelection } from "../../graphics/ui-fonts";

/** Smallest size the picker shrinks a TTF face to before abbreviating. */
const MIN_FIT_SIZE = 10;

/**
 * The UI font at the small size and then smaller sizes of the same face,
 * largest first, for text that must fit a fixed space (a row of nine book
 * names). A bitmap UI font has no smaller sizes, so the ladder is just it.
 */
export function shrinkingFonts(): UiFont[] {
  const small = getDefaultSmallFont();
  const fonts: UiFont[] = [small];
  const selection = getUiFontSelection();
  if (selection.kind !== "ttf") return fonts;
  const path = installedFontPath(selection.file);
  for (let size = selection.size - 1; size >= MIN_FIT_SIZE; size--) {
    const font = TtfFont.load(path, size);
    if (font && font.lineHeight < fonts[fonts.length - 1]!.lineHeight) fonts.push(font);
  }
  return fonts;
}

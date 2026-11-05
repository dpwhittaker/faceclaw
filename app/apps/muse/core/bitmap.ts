/**
 * 8-bit greyscale bitmap, row-major. 0 = off (transparent on the G2 — the
 * real world shows through), 255 = full brightness. The host quantises to
 * 4-bit on the way to the glasses, so only 16 distinct values survive; draw
 * flat greys that land exactly on a level (see `level` in engrave.ts), never
 * anti-aliased ones.
 */
export type Bitmap = { width: number; height: number; data: Uint8Array };

export function createBitmap(width: number, height: number): Bitmap {
  return { width, height, data: new Uint8Array(width * height) };
}

export function clear(b: Bitmap): void {
  b.data.fill(0);
}

export function fillRect(b: Bitmap, x: number, y: number, w: number, h: number, v = 255): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(b.width, x + w);
  const y1 = Math.min(b.height, y + h);
  for (let yy = y0; yy < y1; yy++) b.data.fill(v, yy * b.width + x0, yy * b.width + x1);
}

/** Draw a sprite given as rows of `.`/`X` characters, top-left at (x, y). */
export function drawSprite(b: Bitmap, x: number, y: number, rows: readonly string[], v = 255): void {
  rows.forEach((row, dy) => {
    const py = y + dy;
    if (py < 0 || py >= b.height) return;
    for (let dx = 0; dx < row.length; dx++) {
      if (row[dx] !== 'X') continue;
      const px = x + dx;
      if (px < 0 || px >= b.width) continue;
      b.data[py * b.width + px] = v;
    }
  });
}

export function getPixel(b: Bitmap, x: number, y: number): number {
  return b.data[y * b.width + x];
}

/**
 * Copy a window `dst.width` wide and `src.height` tall out of `src`, starting
 * at column `srcX`, into `dst` with its top at row `dstY`. Wraps horizontally
 * so a marquee loops seamlessly; `srcX` may be any integer, negative included.
 * Rows of `dst` outside the window are left untouched.
 */
export function copyWindow(src: Bitmap, dst: Bitmap, srcX: number, dstY: number): void {
  const start = ((Math.floor(srcX) % src.width) + src.width) % src.width;
  for (let y = 0; y < src.height; y++) {
    const dy = dstY + y;
    if (dy < 0 || dy >= dst.height) continue;
    const srcRow = y * src.width;
    const dstRow = dy * dst.width;
    let copied = 0;
    while (copied < dst.width) {
      const from = (start + copied) % src.width;
      const n = Math.min(dst.width - copied, src.width - from);
      dst.data.set(src.data.subarray(srcRow + from, srcRow + from + n), dstRow + copied);
      copied += n;
    }
  }
}

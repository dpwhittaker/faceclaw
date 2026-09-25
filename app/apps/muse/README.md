# Muse — smooth-scrolling sheet music

A native faceclaw app: engrave a hymn once and scroll the whole score, ported
from the EvenHub app `~/projects/sheet-music-test`.

## What changed from sheet-music-test

The EvenHub original showed **two systems at a time** on a 2×2 image grid and
drew the half you were singing bright, the next half dim, advancing on a swipe —
a workaround for stock firmware, which can only re-upload whole image containers
(~104 ms + 3.9 ms/KB each). Muse drops that whole model (`modes.ts`, `reader.ts`,
`marquee.ts`, the EvenHub `glasses.ts`). On faceclaw CFW an image uploaded to the
on-glasses texture atlas can be re-placed with a tiny record instead of re-sent,
so Muse engraves the full score and **smooth-scrolls** it: one system = one cached
image draw (`GrayImage.drawImage` → `flattenPlanesWithDraws` → `glyph-wire.ts`).
It also uses the full 640×480 display, not EvenHub's 576×288.

## Layout

- `index.ts` — the `AppDefinition` (launcher entry, worker window).
- `muse-app.worker.ts` — the window: engrave on load, scroll state, input, paint.
  Controls: **scroll-up/down** nudge (ring scroll / crown / swipe fallback),
  **click** toggles auto-scroll, **tap-then-long** opens the menu
  (play/pause, speed, jump to top, close).
- `core/` — the device-neutral engraver copied verbatim from sheet-music-test
  (`bitmap.ts`, `font5x8.ts`, `font-clr7x10.ts`, `font-clr8x12.ts`, `engrave.ts`),
  with `.ts` import extensions stripped for faceclaw's bundler.
  - `musicxml-types.ts` — the types slice of sheet-music-test's `musicxml.ts`
    (engrave imports only types; no DOM parser is pulled into the app).
  - `sample-score.ts` — the bundled hymn, **pre-parsed** to a `Score`.
  - `score-image.ts` — engrave → per-system band `GrayImage`s (the faceclaw bridge).

## Regenerating the embedded score

Muse ships a pre-parsed `Score` so it needs no XML parser on the phone. To swap
the hymn, parse a MusicXML file with sheet-music-test's parser and re-embed:

```bash
cd ~/projects/sheet-music-test
cat > scratch/dump-score.ts <<'TS'
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { parseMusicXml } from '../src/musicxml.ts';
const xml = readFileSync(process.argv[2], 'utf8');
process.stdout.write(JSON.stringify(
  parseMusicXml(new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document)));
TS
npx esbuild scratch/dump-score.ts --bundle --platform=node --format=esm \
  --outfile=scratch/dump-score.mjs --external:@xmldom/xmldom
node scratch/dump-score.mjs your-hymn.xml > /tmp/score.json
```

then paste `/tmp/score.json` into `SAMPLE_SCORE` in `core/sample-score.ts`.
(A future version could keep several scores and a picker, or parse XML on device
via a bundled parser.)

## Build / run

Standard faceclaw flow from the repo root: `./build.sh` to typecheck+build,
`./build_and_run.sh` to install over adb, then `adb logcat`. With no glasses,
use faceclaw's on-phone screen mirroring to preview.

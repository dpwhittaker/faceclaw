# Muse: songs and spoken text on the glasses

Muse reads Markdown files with ABC sheet music in them, plain text files and
ABC files. It scrolls smoothly, follows your voice through the words and the
lyrics, and keeps its size settings inside each file. It began as a port of
the EvenHub app `~/projects/sheet-music-test`, but its engraver is the only
part left from that app.

## Using it

- **Home:** Browse for a file (`.md`, `.markdown`, `.txt`, `.abc`), the
  built-in sample (Amazing Grace in bass clef, two verses), or a recent file.
  A recent file reopens at the word you stopped on.
- **Reading:** scroll nudges the page; click pauses or resumes; double-click
  goes back to the file list; tap then hold opens the menu.
- **Follow my voice** (the default mode) listens continuously. Teleprompter's
  `ScriptTracker` aligns the live transcript with the document's words, both
  the text and the sung lyrics. The page glides to keep the next word a
  third of the way down, with that word underlined. Scrolling by hand
  re-anchors the tracker to whatever is now at that line.
- **Auto-scroll** moves at a fixed speed instead (Slow, Medium, Brisk, Fast).
  It pauses when the window loses focus.
- **Sizes and clef** (menu): text size, lyric size, note size, staves per
  screen, and clef (as written, bass or treble). These rows stay open and
  relabel themselves as you click, so you can watch the page change behind
  the menu. Each change is written back into the file.

## Writing a file

````markdown
---
muse:
  text: 20        # body text px; headings scale from it
  lyrics: small   # small | medium | large (5x8, 7x10, 8x12 bitmap fonts)
  notes: medium   # small | medium | large (4, 6 or 8px staff-line pitch)
  staves: 6       # 6 or 4 staves per 288px of screen
  clef: auto      # auto (as written) | bass | treble
---
# Title

Paragraphs, lists, quotes and headings show as text. Inline markup is dropped.

```abc
X:1
T:Shown only when the file is a .abc file
M:3/4
L:1/4
K:G clef=bass
D, | G,2 (B,/G,/) | B,2 A, |
w: A-maz-ing_ grace! how
```
````

Muse adds or updates the `muse:` block itself and leaves every other line
alone. An `.abc` file keeps its settings on a `%%muse text=20 lyrics=small …`
line instead, because YAML at the top would break the file for other ABC
programs.

**ABC support** (one melody line, `core/abc.ts`):

- **Header and fields:** `T:`, `M:`, `L:` (the default unit follows the
  meter), and `K:` with its mode and `clef=bass`/`treble`/`middle=`. Inline
  `[K:]`, `[L:]` and `[M:]` fields also work.
- **Notes:** accidentals, which carry to the end of the bar; octave marks;
  lengths; broken rhythm; tuplets; ties; slurs; chords, from which Muse
  takes the top note; `z` and `Z` rests; bar lines and repeats, which are
  read as plain bar lines; and the fermata decoration.
- **Lyrics:** `w:` lines with `-`, `_`, `*`, `|`, `~` and `\-`.
- **Words after the tune:** `W:` lines, shown as stanzas.
- **Verses:** several `w:` lines under the same music are verses. Each verse
  becomes its own pass through the tune, because Muse reads top to bottom. A
  `w:` group with only one line, such as a refrain, is sung in every pass.
- **Skipped:** grace notes, chord symbols, other decorations, invisible rests
  and every voice after the first.

**Clef override:** choosing bass on a treble tune redraws it an octave lower
in bass clef, where a baritone sings it. Choosing treble on a bass tune moves
it an octave higher.

## How it draws

`core/document-layout.ts` turns the document into a column of rows, each one
`GrayImage`: a wrapped line of text, one system of music, or a rule. Rows are
as tall as their content, so text and staves of any size mix. Each frame
draws the rows in view with `GrayImage.drawImage`. Those image draws upload
to the on-glasses texture atlas once, and every later frame just moves them
with a small placement record (`flattenPlanesWithDraws` → `glyph-wire.ts`).
That is what keeps a whole score scrolling smoothly on CFW.

Each music system's staff sits in its band according to the tune's pitch
range. That leaves room for ledger lines above the staff, which bass-clef
melodies need, as well as below it.

Muse runs on the main thread (not a worker) so it can hold the microphone
the way Teleprompter does, and use the Files app's picker.

## Layout

- `index.ts`: the `AppDefinition`.
- `muse-app.ts`: the window, home list, file picker, and writing settings
  back to files.
- `reader.ts`: `MuseReaderLayer`, which handles scrolling, voice following,
  auto-scroll and the menu.
- `recent-files.ts`: recent files and their resume positions.
- `fonts.ts`: the UI font's face at any pixel size (Terminus when the UI
  font is a bitmap).
- `core/` (no NativeScript imports; tested in `tests/muse.test.cjs`):
  - `abc.ts`: ABC to `Score`s.
  - `document.ts`: Markdown, plain text or ABC to document items.
  - `front-matter.ts`: per-file settings, read and written.
  - `document-layout.ts`: items to rows and word anchors.
  - `engrave.ts`, `bitmap.ts`, `font*.ts`: the pixel engraver from
    sheet-music-test, now with bass clef and a range-aware staff position.
  - `score-types.ts`: what the engraver draws.
  - `sample.ts`: the built-in sample.

## Build and test

`npm test` runs `tests/muse.test.cjs` along with the rest. From the repo
root, `./build.sh` typechecks and builds, `./build_and_run.sh` installs over
adb, and `adb logcat` shows the logs. Muse logs failed reads and writes with
a `muse:` prefix.

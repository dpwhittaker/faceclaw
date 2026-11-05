const test = require('node:test');
const assert = require('node:assert/strict');
const loose = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loader } = require('./helpers/load-typescript.cjs');

const load = loader({}, { '@nativescript/core': {} });
const { BdfFont } = load('app/graphics/bdffont.ts');
const { parseAbc, parseKey, tokenizeLyrics, DIVISIONS } = load('app/apps/muse/core/abc.ts');
const { buildDocument, parseMarkdown, inlineText, fileKind } = load('app/apps/muse/core/document.ts');
const { splitFrontMatter, writeSettings, DEFAULT_SETTINGS } = load('app/apps/muse/core/front-matter.ts');
const { layoutDocument, withClef, textWords } = load('app/apps/muse/core/document-layout.ts');
const { SAMPLE_MARKDOWN } = load('app/apps/muse/core/sample.ts');

const terminus = (name) => BdfFont.parse(fs.readFileSync(path.join(__dirname, '../app/fonts/terminus', name), 'utf8'));
const fonts = { 12: terminus('ter-u12n.bdf'), 16: terminus('ter-u16n.bdf'), 24: terminus('ter-u24n.bdf') };
const fontAt = (px) => (px < 14 ? fonts[12] : px < 20 ? fonts[16] : fonts[24]);

// The loader runs modules in their own realm, so their arrays and objects
// have other prototypes; compare structure only.
const same = (actual, expected) => loose.deepEqual(actual, expected);
const notesOf = (score) => score.measures.flatMap((m) => m.notes);
const tune = (body, header = 'X:1\nL:1/8\nK:C\n') => parseAbc(header + body)[0];

// ── ABC ────────────────────────────────────────────────────────────────────

test('keys: tonic, mode and clef', () => {
  assert.equal(parseKey('G').fifths, 1);
  assert.equal(parseKey('Em').fifths, 1);
  assert.equal(parseKey('F').fifths, -1);
  assert.equal(parseKey('Bb').fifths, -2);
  assert.equal(parseKey('Ador').fifths, 1);
  assert.equal(parseKey('D mix').fifths, 1);
  assert.equal(parseKey('F#m').fifths, 3);
  same(parseKey('bass'), { fifths: 0, clef: 'bass' });
  same(parseKey('G clef=bass'), { fifths: 1, clef: 'bass' });
  assert.equal(parseKey('Bb minor bass').clef, 'bass');
});

test('treble pitches sit on staff steps from the bottom line (E4)', () => {
  const steps = notesOf(tune('E F c B, e\'').verses[0]).map((n) => n.step);
  same(steps, [0, 1, 5, -3, 14]);
});

test('bass clef: the bottom line is G2, and middle= moves it', () => {
  same(notesOf(tune('G,, D, D', 'K:C clef=bass\n').verses[0]).map((n) => n.step), [0, 4, 11]);
  // middle=d puts the written d on the middle line: written an octave up, drawn in bass.
  same(notesOf(tune('d B', 'K:C bass middle=d\n').verses[0]).map((n) => n.step), [4, 2]);
});

test('lengths, dots, broken rhythm and triplets', () => {
  const notes = notesOf(tune('A2 A A/ A3 A>B (3ABC').verses[0]);
  const shape = (n) => [n.type, n.dots, n.duration];
  same(shape(notes[0]), ['quarter', 0, DIVISIONS]);
  same(shape(notes[1]), ['eighth', 0, DIVISIONS / 2]);
  same(shape(notes[2]), ['16th', 0, DIVISIONS / 4]);
  same(shape(notes[3]), ['quarter', 1, (DIVISIONS * 3) / 2]);
  same(shape(notes[4]), ['eighth', 1, (DIVISIONS * 3) / 4]);
  same(shape(notes[5]), ['16th', 0, DIVISIONS / 4]);
  same(notes.slice(6).map(shape), Array(3).fill(['eighth', 0, DIVISIONS / 3]));
});

test('default unit length follows the meter', () => {
  assert.equal(notesOf(parseAbc('M:2/4\nK:C\nA')[0].verses[0])[0].type, '16th');
  assert.equal(notesOf(parseAbc('M:6/8\nK:C\nA')[0].verses[0])[0].type, 'eighth');
});

test('bars, accidentals, ties, slurs, chords, rests and fermatas', () => {
  const score = tune('|: ^F G- | G (AB) | [CEG]2 z2 | !fermata!c4 :|[1 Z |] "Am" {g}A x y').verses[0];
  assert.equal(score.measures.length, 6);
  const [f, g1, g2, a, b, chord, rest, c] = notesOf(score);
  assert.equal(f.accidental, 'sharp');
  assert.equal(f.alter, 1);
  assert.equal(g1.tieStart, true);
  assert.equal(g2.tieStop, true);
  assert.equal(a.slurStart, true);
  assert.equal(b.slurStop, true);
  assert.equal(chord.step, 2); // the chord's top note, G4
  assert.equal(chord.type, 'quarter');
  assert.equal(rest.rest, true);
  assert.equal(c.fermata, true);
  assert.equal(score.measures[4].notes[0].measureRest, true);
  // The chord symbol, grace note and invisible rest leave only the A.
  same(score.measures[5].notes.map((n) => n.step), [3]);
});

test('key signature sharps carry alter but no accidental; bar accidentals carry on', () => {
  const notes = notesOf(tune('F ^c c | c', 'K:D\n').verses[0]);
  same(notes.map((n) => [n.alter, n.accidental]), [[1, undefined], [1, 'sharp'], [1, undefined], [1, undefined]]);
  assert.equal(tune('F', 'K:D\n').verses[0].measures[0].fifths, 2);
});

test('lyric tokens: hyphens, holds, skips, bars and escapes', () => {
  const kinds = tokenizeLyrics('A-maz-ing_ grace * | how\\-dy ~two').map((t) => (t.kind === 'syllable' ? `${t.text}:${t.syllabic}` : t.kind));
  same(kinds, ['A:begin', 'maz:middle', 'ing:end', 'hold', 'grace:single', 'skip', 'bar', 'how-dy:single', ' two:single']);
});

test('lyrics skip rests, and | moves to the next bar', () => {
  const notes = notesOf(tune('A z B C | D E\nw: one two | three').verses[0]);
  same(notes.map((n) => n.lyric?.text ?? null), ['one', null, 'two', null, 'three', null]);
});

test('stacked w: lines become one pass per verse; a lone w: line repeats', () => {
  const t = tune('A B | C D |\nw: one two three four\nw: uno dos tres cuatro\nE F |\nw: re-frain');
  assert.equal(t.verses.length, 2);
  const lyrics = (score) => notesOf(score).map((n) => n.lyric?.text ?? null);
  same(lyrics(t.verses[0]), ['one', 'two', 'three', 'four', 're', 'frain']);
  same(lyrics(t.verses[1]), ['uno', 'dos', 'tres', 'cuatro', 're', 'frain']);
});

test('only the first voice is read', () => {
  const t = parseAbc('X:1\nL:1/4\nV:1\nV:2 clef=bass\nK:C\n[V:1] A B |\n[V:2] C, D, |\nV:1\nc d |');
  same(notesOf(t[0].verses[0]).map((n) => n.step), [3, 4, 5, 6]);
});

test('tunes split on X:, and W: words come after', () => {
  const tunes = parseAbc('free text\n\nX:1\nT:One\nK:C\nA\nW:Words here\nW:\nW:Second stanza\n\nfree text\nX:2\nT:Two\nK:G\nB');
  same(tunes.map((t) => t.title), ['One', 'Two']);
  same(tunes[0].words, ['Words here', '', 'Second stanza']);
});

test('the sample hymn: bass clef, G major, two verses aligned to the same notes', () => {
  const doc = buildDocument(splitFrontMatter(SAMPLE_MARKDOWN, 'markdown').body, 'markdown');
  const scores = doc.items.filter((i) => i.kind === 'music').map((i) => i.score);
  assert.equal(scores.length, 2);
  assert.equal(scores[0].clef, 'bass');
  assert.equal(scores[0].measures[0].fifths, 1);
  const sung = (score) => notesOf(score).filter((n) => n.lyric).map((n) => n.lyric.text);
  same(sung(scores[0]).slice(0, 6), ['A', 'maz', 'ing', 'grace!', 'How', 'sweet']);
  same(sung(scores[1]).slice(-5), ['hour', 'I', 'first', 'be', 'lieved.']);
  // Both verses fill the same notes.
  const filled = (score) => notesOf(score).map((n) => !!n.lyric);
  same(filled(scores[0]), filled(scores[1]));
});

// ── Markdown ───────────────────────────────────────────────────────────────

test('markdown structure: headings, paragraphs (line breaks kept), lists, quotes, rules, code', () => {
  const items = parseMarkdown([
    '# Title', 'Setext', '---', 'one', 'two  ', 'three', '', '- a', '  more', '1. b', '> said', '***',
    '```', 'x = 1', '```', '```abc', 'K:C', 'C', '```',
  ].join('\n'));
  const brief = items.map((i) => (i.kind === 'text' ? [i.style, i.text, i.marker ?? '', i.quote] : [i.kind]));
  same(brief, [
    ['title', 'Title', '', false],
    ['heading', 'Setext', '', false],
    ['body', 'one\ntwo\nthree', '', false],
    ['body', 'a\nmore', '•', false],
    ['body', 'b', '1.', false],
    ['body', 'said', '', true],
    ['rule'],
    ['code', 'x = 1', '', false],
    ['music'],
  ]);
});

test('inline markup is dropped, escapes kept', () => {
  assert.equal(inlineText('**bold** *it* _em_ snake_case `code` [link](http://x) ![alt](i.png) \\*star\\*'),
    'bold it em snake_case code link alt *star*');
});

test('file kinds', () => {
  assert.equal(fileKind('song.MD'), 'markdown');
  assert.equal(fileKind('notes.txt'), 'text');
  assert.equal(fileKind('tune.abc'), 'abc');
  assert.equal(fileKind('photo.jpg'), null);
});

// ── Front matter ───────────────────────────────────────────────────────────

test('settings are read from front matter and written back in place', () => {
  const text = '---\r\ntitle: Song\r\nmuse:\r\n  text: 24\r\n  clef: bass\r\ntags: [a]\r\n---\r\n# Song\r\n';
  const { body, settings } = splitFrontMatter(text, 'markdown');
  assert.equal(body, '# Song\r\n');
  same(settings, { ...DEFAULT_SETTINGS, text: 24, clef: 'bass' });
  const written = writeSettings(text, 'markdown', { ...settings, notes: 'large' });
  assert.equal(written, '---\r\ntitle: Song\r\nmuse:\r\n  text: 24\r\n  lyrics: small\r\n  notes: large\r\n  staves: 6\r\n  clef: bass\r\ntags: [a]\r\n---\r\n# Song\r\n');
});

test('front matter is added when missing, or extended when it has no muse block', () => {
  const added = writeSettings('# Hi\n', 'markdown', DEFAULT_SETTINGS);
  assert.equal(added, '---\nmuse:\n  text: 20\n  lyrics: small\n  notes: medium\n  staves: 6\n  clef: auto\n---\n# Hi\n');
  same(splitFrontMatter(added, 'markdown'), { body: '# Hi\n', settings: DEFAULT_SETTINGS });
  const extended = writeSettings('---\ntitle: x\n---\nbody', 'markdown', { ...DEFAULT_SETTINGS, staves: 4 });
  assert.match(extended, /^---\ntitle: x\nmuse:\n[\s\S]*staves: 4\n  clef: auto\n---\nbody$/);
});

test('flow-style settings are read; invalid values fall back', () => {
  const { settings } = splitFrontMatter('---\nmuse: {text: 18, notes: huge, staves: "4"}\n---\n', 'markdown');
  same(settings, { ...DEFAULT_SETTINGS, text: 18, staves: 4 });
});

test('abc files keep settings in a %%muse line', () => {
  const abc = 'X:1\nK:C\nC\n';
  const written = writeSettings(abc, 'abc', { ...DEFAULT_SETTINGS, clef: 'bass' });
  assert.equal(written, '%%muse text=20 lyrics=small notes=medium staves=6 clef=bass\nX:1\nK:C\nC\n');
  assert.equal(splitFrontMatter(written, 'abc').settings.clef, 'bass');
  assert.equal(parseAbc(written).length, 1);
  assert.equal(writeSettings(written, 'abc', DEFAULT_SETTINGS).split('\n')[0], '%%muse text=20 lyrics=small notes=medium staves=6 clef=auto');
});

// ── Layout ─────────────────────────────────────────────────────────────────

test('layout: rows stack without overlap, and every word has an anchor', () => {
  const doc = buildDocument(splitFrontMatter(SAMPLE_MARKDOWN, 'markdown').body, 'markdown');
  const layout = layoutDocument(doc, DEFAULT_SETTINGS, 560, fontAt);
  for (let i = 1; i < layout.rows.length; i++) {
    assert.ok(layout.rows[i].y >= layout.rows[i - 1].y + layout.rows[i - 1].height, `row ${i} overlaps`);
  }
  assert.equal(layout.words.length, layout.anchors.length);
  same(layout.words.slice(0, 4), ['amazing', 'grace', 'this', 'is']);
  // Sung words join their syllables, in reading order after the text.
  const sung = layout.words.slice(layout.words.indexOf('verses') + 4);
  same(sung.slice(0, 5), ['amazing', 'grace', 'how', 'sweet', 'the']);
  for (let i = 1; i < layout.anchors.length; i++) {
    assert.ok(layout.anchors[i].row >= layout.anchors[i - 1].row, 'anchors run top to bottom');
  }
  const musicRows = layout.rows.filter((row) => row.height === 48);
  assert.ok(musicRows.length >= 4, 'two verses of at least two systems');
});

test('layout: text size and staves change only heights, never the words', () => {
  const doc = buildDocument(splitFrontMatter(SAMPLE_MARKDOWN, 'markdown').body, 'markdown');
  const small = layoutDocument(doc, DEFAULT_SETTINGS, 560, fontAt);
  const big = layoutDocument(doc, { ...DEFAULT_SETTINGS, text: 28, staves: 4, lyrics: 'large', notes: 'large' }, 560, fontAt);
  same(big.words, small.words);
  assert.ok(big.height > small.height);
  assert.ok(big.rows.some((row) => row.height === 72));
});

test('clef override moves the music an octave into the other clef', () => {
  const treble = tune('E c').verses[0];
  const bass = withClef(treble, 'bass');
  assert.equal(bass.clef, 'bass');
  same(notesOf(bass).map((n) => n.step), [5, 10]); // E3 and C4 on the bass staff
  same(notesOf(withClef(bass, 'treble')).map((n) => n.step), [0, 5]);
  assert.equal(withClef(treble, 'auto'), treble);
});

test('stage directions: words wholly inside [brackets] or (parentheses)', () => {
  const flags = (text) => textWords(text).map((line) => line.map((w) => `${w.text}${w.direction ? '*' : ''}`).join(' '));
  same(flags('[wonder] Have you [wipe sweat] ever'), ['[wonder]* Have you [wipe* sweat]* ever']);
  // Nesting carries across a line break, and punctuation-only words are never directions.
  same(flags('(She is holding\na walkie-talkie.) Do not — Gary'), ['(She* is* holding*', 'a* walkie-talkie.)* Do not — Gary']);
  same(flags('it(s) 1) first'), ['it(s) 1) first']);
});

test('layout: directions are drawn dim and left out of the words to follow', () => {
  const md = '# Smith\n\n*[wonder]* Have you ever\n*[inform]* Did you know\n\n*(Unclosed aside\n\nBack to lines.';
  const layout = layoutDocument(buildDocument(md, 'markdown'), DEFAULT_SETTINGS, 560, fontAt);
  same(layout.words, ['smith', 'have', 'you', 'ever', 'did', 'you', 'know', 'back', 'to', 'lines']);
  const values = (row) => new Set(layout.rows[row].image.pixels);
  assert.ok(values(1).has(100), 'the cue is drawn dim');
  assert.ok(values(1).has(220), 'the line is drawn at body brightness');
  assert.ok(!values(4).has(100), 'an unclosed ( dims only its own paragraph');
});

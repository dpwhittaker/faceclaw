const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loader } = require('./helpers/load-typescript.cjs');

const plain = loader({}, { '@nativescript/core': {} });
const { BdfFont } = plain('app/graphics/bdffont.ts');
const font = (name) => BdfFont.parse(fs.readFileSync(path.join(__dirname, '../app/fonts/terminus', name), 'utf8'));
const small = font('ter-u12n.bdf');
const medium = font('ter-u16n.bdf');
const large = font('ter-u24n.bdf');
const load = loader({}, {
  '@nativescript/core': {},
  '../../graphics/ui-fonts': {
    getDefaultSmallFont: () => small, getDefaultMediumFont: () => medium, getDefaultLargeFont: () => large,
    getUiFontSelection: () => ({ kind: 'bitmap', face: 'terminus' }),
  },
  './bible-fonts': { shrinkingFonts: () => [small] },
  '../../native/frame-timings': { spanCurrent: (_name, paint) => paint() },
  '../native/frame-timings': { spanCurrent: (_name, paint) => paint() },
});

const tree = load('app/apps/bible/trinary-tree.ts');
const books = load('app/apps/bible/books.ts');
const { PassagePicker, BOOK_TREE } = load('app/apps/bible/passage-picker.ts');
const { PassagePickerLayer } = load('app/apps/bible/picker-layer.ts');
const { RingSwipeFilter } = load('app/ui/ring-swipe-filter.ts');
const { StudyDocument } = load('app/apps/bible/study-document.ts');
const layers = load('app/ui/layers.ts');
const gestures = load('app/ui/gestures.ts');
const { TOP, MIDDLE, BOTTOM } = { TOP: tree.SLOT_TOP, MIDDLE: tree.SLOT_MIDDLE, BOTTOM: tree.SLOT_BOTTOM };
/** Values from the loaded modules' own realm, as plain data (their prototypes differ from this file's). */
const plainOf = (value) => JSON.parse(JSON.stringify(value));

test('ranges split into thirds as even as they go, so 81 items are four moves away', () => {
  assert.deepEqual(plainOf(tree.thirds(150)), [50, 50, 50]);
  assert.deepEqual(plainOf(tree.thirds(50)), [17, 17, 16]);
  assert.deepEqual(plainOf(tree.thirds(4)), [2, 1, 1]);
  const psalms = tree.numberTree(1, 150);
  assert.deepEqual(plainOf(psalms.children.map((child) => tree.rangeLabel(child))), ['1–50', '51–100', '101–150']);
  assert.equal(tree.nodeDepth(tree.numberTree(1, 81)), 4);
  assert.equal(tree.nodeDepth(tree.numberTree(1, 82)), 5);
  // Two items take the swipes, leaving the slow tap empty.
  const pair = tree.numberTree(1, 2);
  assert.equal(pair.children[MIDDLE], null);
  assert.equal(pair.children[TOP].value, 1);
  assert.equal(pair.children[BOTTOM].value, 2);
});

test('the book picker opens on Genesis-Job, Psalms-Malachi and Matthew-Revelation, each at most 27 books', () => {
  assert.deepEqual(plainOf(BOOK_TREE.children.map((child) => tree.rangeLabel(child))),
    ['Genesis–Job', 'Psalms–Malachi', 'Matthew–Revelation']);
  for (const child of BOOK_TREE.children) assert.equal(tree.nodeDepth(child), 3);
  assert.equal(books.BOOKS.length, 66);
  assert.equal(books.formatRef(books.verseId(19, 23, 1)), 'Ps 23:1');
  assert.equal(books.formatRef(books.verseId(65, 1, 3), books.verseId(65, 1, 5)), 'Jude 3-5');
  assert.equal(books.formatRef(books.verseId(1, 1, 31), books.verseId(1, 2, 3)), 'Gen 1:31-2:3');
});

function picker() {
  return new PassagePicker((book, chapter) => (book === 19 && chapter === 117 ? 2 : 30));
}

test('swipes and taps walk from a book to a chapter to a verse', () => {
  const p = picker();
  // Matthew-Revelation, then Hebrews-Revelation, then 2 Peter-2 John, then 2 John.
  for (const slot of [BOTTOM, BOTTOM, MIDDLE]) assert.equal(p.enter(slot).kind, 'moved');
  // 2 John has one chapter, so picking it goes straight to its verses.
  assert.equal(p.enter(BOTTOM).kind, 'moved');
  assert.deepEqual(plainOf(p.getPhase()), { kind: 'verse', book: 63, chapter: 1 });
  let outcome;
  do outcome = p.enter(TOP); while (outcome.kind === 'moved');
  assert.deepEqual(plainOf(outcome), { kind: 'picked', ref: { book: 63, chapter: 1, verse: 1 } });
  // After a pick the picker waits at the outermost level of the same chapter's verses.
  assert.ok(p.getCursor().isAtRoot());
  assert.deepEqual(plainOf(p.getPhase()), { kind: 'verse', book: 63, chapter: 1 });
});

test('double-tap zooms out, then steps back a phase, then leaves', () => {
  const p = picker();
  p.enter(MIDDLE); // Psalms-Malachi
  p.enter(TOP); // Psalms-Lamentations
  p.enter(TOP); // Psalms-Ecclesiastes
  assert.equal(p.enter(TOP).kind, 'moved'); // Psalms
  assert.deepEqual(plainOf(p.getPhase()), { kind: 'chapter', book: 19 });
  p.enter(BOTTOM); // 101-150
  assert.equal(p.back().kind, 'moved');
  assert.ok(p.getCursor().isAtRoot());
  assert.equal(p.back().kind, 'moved');
  assert.deepEqual(plainOf(p.getPhase()), { kind: 'book' });
  assert.equal(p.back().kind, 'exit');
  // A one-chapter book's verses step back to the books, not to a chapter choice.
  p.showVerses(57, 1);
  p.back();
  assert.deepEqual(plainOf(p.getPhase()), { kind: 'book' });
});

test('the picker layer drops the R1 repeating a swipe, and reports a pick', async () => {
  const picked = [];
  let exits = 0;
  const p = picker();
  const layer = new PassagePickerLayer({ picker: p, onPicked: (ref) => picked.push(ref), onExit: () => exits++ });
  const stack = new layers.LayerStack(layer, layers.noopLayerActions, { width: 576, height: 452 });
  let clock = 1_000_000;
  const send = (type, gap = 600) => stack.handleInput({ ...gestures.makeInputEvent({ type, source: 'ring' }), timestampMs: clock += gap });
  await send('scroll-down');
  await send('scroll-down', 90); // a repeat report of the same swipe
  assert.equal(p.getCursor().depth(), 1);
  await send('ring-press', 20);
  await send('scroll-down', 60); // a fresh touch: a new swipe however quick
  assert.equal(p.getCursor().depth(), 2);
  assert.ok(stack.paint().length > 0);
  await send('double-click');
  await send('double-click');
  await send('double-click');
  assert.equal(exits, 1);
  assert.equal(picked.length, 0);
});

test('the swipe filter passes temple swipes and other gestures untouched', () => {
  const filter = new RingSwipeFilter();
  const at = (type, timestampMs, source) => ({ type, timestampMs, source });
  assert.equal(filter.accept(at('scroll-up', 1000)), true);
  assert.equal(filter.accept(at('scroll-up', 1100)), false);
  assert.equal(filter.accept(at('scroll-up', 1200, 'left-arm')), true);
  assert.equal(filter.accept(at('click', 1210)), true);
  assert.equal(filter.accept(at('scroll-up', 1500)), true);
});

function pageOf(blocks) {
  const doc = new StudyDocument();
  doc.setBlocks(blocks);
  doc.layout({ small, medium }, 400, 200);
  return doc;
}

test('swipes move block by block; tapping a block cites several references steps into them', () => {
  const opened = [];
  const link = (key) => ({ text: key, action: { key, run: () => opened.push(key) } });
  const tall = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const doc = pageOf([
    { runs: [{ text: 'heading' }] },
    { runs: [{ text: 'see ' }, link('a'), { text: ', ' }, link('b'), { text: ' and ' }, link('c')] },
    { runs: [{ text: 'a cross-reference' }], action: { key: 'x', run: () => opened.push('x') } },
    { runs: [{ text: tall }] },
    { runs: [{ text: 'after' }], key: 'after' },
  ]);
  const ctx = {};
  assert.equal(doc.focusedIndex(), 0);
  assert.equal(doc.tapMeaning(), 'none');
  doc.moveDown();
  assert.equal(doc.tapMeaning(), 'links');
  doc.activate(ctx);
  assert.ok(doc.inLinks());
  doc.moveDown();
  doc.activate(ctx);
  assert.deepEqual(plainOf(opened), ['b']);
  doc.leaveLinks();
  doc.moveDown();
  doc.activate(ctx);
  assert.deepEqual(plainOf(opened), ['b', 'x']);
  // The tall block: the focus lands on it, then swipes scroll through it a page at a time.
  doc.moveDown();
  assert.equal(doc.focusedIndex(), 3);
  let swipes = 0;
  while (doc.focusedIndex() === 3 && swipes < 20) {
    const before = doc.scrollTop();
    doc.moveDown();
    assert.ok(doc.scrollTop() - before <= 200, `scrolled ${doc.scrollTop() - before}px in one swipe`);
    swipes++;
  }
  assert.equal(doc.focusedKey(), 'after');
  assert.ok(swipes > 2);
  // And back up through it the same way.
  swipes = 0;
  while (doc.focusedIndex() !== 2 && swipes < 20) {
    doc.moveUp();
    swipes++;
  }
  assert.equal(doc.focusedIndex(), 2);
  assert.ok(swipes > 2);
});

test('the focus survives a rebuild of the page, or keeps its place when its block is gone', () => {
  const row = (key) => ({ runs: [{ text: key }], action: { key, run() {} } });
  const doc = pageOf([row('a'), row('b'), row('more')]);
  doc.moveDown();
  assert.equal(doc.focusedKey(), 'b');
  doc.setBlocks([{ runs: [{ text: 'new heading' }] }, row('a'), row('b'), row('more')]);
  doc.focusOn(doc.focusedKey(), doc.focusedIndex());
  doc.layout({ small, medium }, 400, 200);
  assert.equal(doc.focusedKey(), 'b');
  doc.moveDown();
  assert.equal(doc.focusedKey(), 'more');
  // "Show more" is replaced by what it loaded: the focus lands on the first of it.
  doc.setBlocks([{ runs: [{ text: 'new heading' }] }, row('a'), row('b'), row('c'), row('d')]);
  doc.focusOn('more', doc.focusedIndex());
  doc.layout({ small, medium }, 400, 200);
  assert.equal(doc.focusedKey(), 'c');
});

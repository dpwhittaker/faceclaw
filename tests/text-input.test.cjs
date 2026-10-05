const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function load(file, modules = {}) {
  const context = { exports: {}, console, require: (name) => modules[name] ?? {} };
  vm.runInNewContext(ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context, { filename: file });
  return context.exports;
}

const kb = load('app/ui/shell/trinary-keyboard.ts');
// Objects made inside the vm context have its prototypes; compare as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Every key under a node with the gestures it takes from there (zooms plus the typing tap). */
function keyCosts(node, spent = 0, out = []) {
  if (node.kind === 'key') {
    out.push({ text: node.text, gestures: spent + 1 });
    return out;
  }
  node.children.forEach((child, slot) => {
    if (!child) return;
    // A tap types a single middle key directly; anything else is one zoom away.
    if (slot === kb.SLOT_MIDDLE && child.kind === 'key') out.push({ text: child.text, gestures: spent + 1 });
    else keyCosts(child, spent + 1, out);
  });
  return out;
}

function groups(node, out = []) {
  if (node.kind === 'group') {
    out.push(node);
    for (const child of node.children) if (child) groups(child, out);
  }
  return out;
}

test('the letters are a-z and space, with the nine most common characters a tap away at the last step', () => {
  const costs = keyCosts(kb.LETTERS);
  assert.equal(costs.length, 27);
  assert.deepEqual(costs.map((c) => c.text).sort(), [...' abcdefghijklmnopqrstuvwxyz']);
  const quick = costs.filter((c) => c.gestures === 3).map((c) => c.text).sort();
  assert.deepEqual(quick, [...' aehinost']);
  assert.ok(costs.every((c) => c.gestures === 3 || c.gestures === 4));
  // Three boxes of three rows of three.
  for (const box of kb.LETTERS.children) {
    assert.equal(box.kind, 'group');
    for (const row of box.children) assert.equal(row.children.filter(Boolean).length, 3);
  }
});

test('every printable ASCII character, Enter and Tab can be typed from the root, numbers and punctuation on top', () => {
  const typed = new Set(keyCosts(kb.KEYBOARD_ROOT).map((c) => c.text));
  for (let code = 0x20; code <= 0x7e; code++) {
    const char = String.fromCharCode(code);
    if (/[A-Z]/.test(char)) continue; // capitals are long-press on the lowercase key
    assert.ok(typed.has(char), JSON.stringify(char));
  }
  assert.ok(typed.has('\n')); assert.ok(typed.has('\t'));
  // Digits and common punctuation: double-tap out to the root, then five or six gestures.
  const top = keyCosts(kb.KEYBOARD_ROOT.children[kb.SLOT_TOP]);
  for (const char of '0123456789.,?!\'"') {
    const key = top.find((c) => c.text === char);
    assert.ok(key && key.gestures + 1 <= 6, char);
  }
  assert.equal(kb.KEYBOARD_ROOT.children[kb.SLOT_MIDDLE], kb.LETTERS);
  // The bottom set reaches well past ASCII and is the deepest.
  const more = keyCosts(kb.KEYBOARD_ROOT.children[kb.SLOT_BOTTOM]);
  for (const char of ['é', '€', '→', '┼', '★', 'ω', 'ж', 'あ', 'ア', '。']) {
    assert.ok(more.some((c) => c.text === char), char);
  }
  const deepest = (node) => kb.nodeDepth(node);
  assert.ok(deepest(kb.KEYBOARD_ROOT.children[kb.SLOT_BOTTOM]) > deepest(kb.KEYBOARD_ROOT.children[kb.SLOT_TOP]));
});

test('every group offers at least two boxes and every key is a single character', () => {
  for (const group of groups(kb.KEYBOARD_ROOT)) {
    assert.equal(group.children.length, 3);
    assert.ok(group.children.filter(Boolean).length >= 2, group.label ?? JSON.stringify(group.children));
  }
  for (const { text } of keyCosts(kb.KEYBOARD_ROOT)) assert.equal(Array.from(text).length, 1, text);
});

test('the cursor opens at the letters, types with swipes and taps, and returns there after each key (digits to the numbers)', () => {
  const k = new kb.TrinaryKeyboard();
  assert.ok(k.isAtHome()); assert.deepEqual(plain(k.trail()), ['Letters']);
  const type = (...moves) => {
    let outcome;
    for (const move of moves) {
      outcome = move === 'up' ? k.zoom(kb.SLOT_TOP) : move === 'down' ? k.zoom(kb.SLOT_BOTTOM)
        : k.tap(move === 'hold');
    }
    return outcome;
  };
  assert.deepEqual(plain(type('down', 'tap', 'tap')), { kind: 'typed', text: 't' });
  assert.ok(k.isAtHome());
  assert.deepEqual(plain(type('up', 'down', 'tap')), { kind: 'typed', text: 'h' });
  assert.deepEqual(plain(type('up', 'tap', 'hold')), { kind: 'typed', text: 'E' });
  // A side key is zoomed into first, then typed (or capitalized) on its own.
  assert.deepEqual(plain(type('up', 'up', 'up')), { kind: 'moved' });
  assert.equal(k.current().text, 'b');
  assert.deepEqual(plain(k.zoom(kb.SLOT_TOP)), { kind: 'none' });
  assert.deepEqual(plain(k.tap(true)), { kind: 'typed', text: 'B' });
  // Long-press never zooms.
  assert.deepEqual(plain(k.tap(true)), { kind: 'none' }); assert.ok(k.isAtHome());
  // Space is the middle of the last row.
  assert.deepEqual(plain(type('down', 'down', 'tap')), { kind: 'typed', text: ' ' });
  // Double-tap zooms out to the root, then has nowhere further to go.
  k.zoom(kb.SLOT_TOP);
  assert.equal(k.back(), true); assert.ok(k.isAtHome());
  assert.equal(k.back(), true); assert.ok(k.isAtRoot());
  assert.equal(k.back(), false);
  // A digit returns to numbers and punctuation, ready for the next digit or a decimal point.
  assert.deepEqual(plain(type('up', 'up', 'tap', 'tap')), { kind: 'typed', text: '5' });
  assert.deepEqual(plain(k.trail()), ['Numbers & punctuation']);
  assert.deepEqual(plain(type('down', 'tap', 'tap', 'tap')), { kind: 'typed', text: '0' });
  assert.deepEqual(plain(k.trail()), ['Numbers & punctuation']);
  assert.deepEqual(plain(type('tap', 'tap', 'tap')), { kind: 'typed', text: '.' });
  assert.ok(k.isAtHome());
  k.back();
  assert.deepEqual(plain(type('up', 'down', 'down', 'down', 'tap')), { kind: 'typed', text: '\n' });
  k.back(); k.tap();
  assert.ok(k.isAtHome());
});

// --- The dialog ---

const textwrap = load('app/graphics/textwrap.ts');
const graphics = load('app/graphics/image.ts', { './textwrap': textwrap });
const plane = load('app/graphics/plane.ts', { './image': graphics });
const gestures = load('app/ui/gestures.ts');
const numeric = load('app/util/numeric-util.ts');
const metrics = load('app/ui/metrics.ts');
const { BdfFont } = load('app/graphics/bdffont.ts');
const bdf = (file) => BdfFont.parse(read(`app/fonts/terminus/${file}`));
const fonts = {
  getDefaultSmallFont: () => smallFont, getDefaultMediumFont: () => mediumFont, getDefaultLargeFont: () => largeFont,
};
const smallFont = bdf('ter-u12n.bdf'), mediumFont = bdf('ter-u16n.bdf'), largeFont = bdf('ter-u24n.bdf');
const layers = load('app/ui/layers.ts', {
  '../graphics/image': graphics, '../graphics/plane': plane, './gestures': gestures,
  '../native/frame-timings': { spanCurrent: (_name, paint) => paint() },
});
const menu = load('app/ui/menu.ts', {
  '../graphics/image': graphics, '../graphics/ui-fonts': fonts, '../graphics/textwrap': textwrap,
  '../util/numeric-util': numeric, './gestures': gestures, './metrics': metrics,
});
const inputDialog = load('app/ui/shell/input-dialog.ts', {
  '../../graphics/image': graphics, '../../graphics/textwrap': textwrap, '../../graphics/ui-fonts': fonts,
  '../menu': menu, '../metrics': metrics, './geometry': { MIN_WINDOW_HEIGHT: 288, minWindowTop: () => 96 },
});
const { TextInputLayer } = load('app/ui/shell/text-input.ts', {
  '../../graphics/image': graphics, '../../graphics/textwrap': textwrap, '../../graphics/ui-fonts': fonts,
  '../gestures': gestures, '../layers': layers, '../menu': menu, './input-dialog': inputDialog,
  './trinary-keyboard': kb,
});

function dialog(targets = ['app', 'assistant']) {
  const sent = [];
  let closed = 0, renders = 0;
  const base = { paint: () => new graphics.GrayImage(640, 480), handleInput() {} };
  const stack = new layers.LayerStack(base, { ...layers.noopLayerActions, requestRender: () => { renders++; } });
  const layer = new TextInputLayer({
    actions: { ...layers.noopLayerActions, requestRender: () => { renders++; } },
    onClosed: () => { closed++; },
    dismiss: () => stack.popIfTop((top) => top === layer),
    sendTargets: targets.map((id) => ({ id, label: id, onSend: (text) => sent.push([id, text]) })),
    defaultTargetIndex: 0,
  });
  stack.push(layer);
  // Deliberate gestures, spaced as a person makes them (the dialog drops swipe repeats).
  let clock = 1_000_000;
  const at = (type, gapMs = 600) => ({ ...gestures.makeInputEvent({ type, source: 'ring' }), timestampMs: clock += gapMs });
  const input = async (...types) => {
    for (const type of types) await stack.handleInput(at(type));
  };
  return { stack, layer, sent, input, at, closed: () => closed, renders: () => renders };
}

test('the dialog types with the ring, capitalizes on long-press and deletes on tap-then-hold', async () => {
  const d = dialog();
  assert.equal(d.layer.acceptsHoldGestures, true);
  await d.input('scroll-up', 'scroll-down', 'long-press');            // H
  await d.input('scroll-down', 'scroll-up', 'scroll-up', 'click');    // u
  await d.input('ring-press');                                        // ignored
  assert.equal(d.layer.getText(), 'Hu');
  await d.input('short-then-long-press');
  await d.input('click', 'scroll-up', 'click');                       // i
  assert.equal(d.layer.getText(), 'Hi');
  await d.input('short-then-long-press', 'short-then-long-press', 'short-then-long-press');
  assert.equal(d.layer.getText(), '');
});

test('the extra swipe reports one R1 swipe can send are dropped, so a swipe zooms one level', async () => {
  const d = dialog();
  const swipe = (type, gapMs) => d.stack.handleInput(d.at(type, gapMs));
  await swipe('scroll-up');            // into b a c / d e f / g h j
  await swipe('scroll-up', 90);        // the ring repeating that swipe
  await swipe('scroll-up', 90);
  await swipe('scroll-down', 600);     // a deliberate swipe: g h j
  await d.input('click');              // h, the middle key
  assert.equal(d.layer.getText(), 'h');
});

test('double-tap past the root opens the menu; double-tap there keeps typing; a send delivers the trimmed text', async () => {
  const d = dialog();
  await d.input('scroll-up', 'click', 'click', 'double-click');       // e, then out to the root
  await d.input('double-click');                                      // menu
  // An empty send row would do nothing, but there is text: double-tap returns to the letters.
  await d.input('double-click');
  await d.input('scroll-down', 'scroll-down', 'click');               // space
  await d.input('double-click', 'double-click');                      // menu again, Type Into App highlighted
  await d.input('scroll-down', 'click');                              // the second target
  assert.deepEqual(plain(d.sent), [['assistant', 'e']]);
  assert.ok(d.stack.isAtBase()); assert.equal(d.closed(), 1);
});

test('with nothing typed the send rows do nothing, and Discard closes', async () => {
  const d = dialog(['app']);
  await d.input('double-click', 'double-click', 'click');
  assert.equal(d.stack.isAtBase(), false); assert.deepEqual(d.sent, []);
  await d.input('scroll-down', 'scroll-down', 'click');               // Keep typing, Discard
  assert.ok(d.stack.isAtBase()); assert.deepEqual(d.sent, []); assert.equal(d.closed(), 1);
});

test('every level paints inside the dialog box', async () => {
  const d = dialog();
  // The dialog box: x 40..600, and 24px inside the band that starts at y 96.
  const check = () => {
    const { image } = d.stack.paint().at(-1);
    const glyphs = image.draws.filter((draw) => draw.kind === 'glyph');
    assert.ok(glyphs.length > 0);
    for (const draw of glyphs) {
      assert.ok(draw.x >= 40 && draw.x + draw.glyph.dwidthX <= 600, `x ${draw.x}`);
      assert.ok(draw.y >= 120 && draw.y + draw.font.lineHeight <= 360, `y ${draw.y}`);
    }
  };
  check();                                                             // the letters
  await d.input('scroll-up'); check();                                 // a box of nine
  await d.input('scroll-down'); check();                               // a row of three
  await d.input('scroll-up'); check();                                 // a single key
  await d.input('click', 'double-click'); check();                     // the root
  await d.input('scroll-down', 'scroll-down', 'scroll-down'); check(); // deep in More
  await d.input('double-click', 'double-click', 'double-click', 'double-click'); check(); // menu
});

test('Text input in the system menu opens the ring keyboard over the window, which receives what is typed', async () => {
  const typed = [];
  const textInput = load('app/ui/shell/text-input.ts', {
    '../../graphics/image': graphics, '../../graphics/textwrap': textwrap, '../../graphics/ui-fonts': fonts,
    '../gestures': gestures, '../layers': layers, '../menu': menu, './input-dialog': inputDialog,
    './trinary-keyboard': kb,
  });
  const { shell } = load('app/ui/shell/shell.ts', {
    '../../graphics/image': graphics, '../layers': layers, '../menu': menu, '../gestures': gestures,
    '../input-monitor': load('app/ui/input-monitor.ts'), '../dashboard-settings': { brightnessSetting: { get: () => 'auto' } },
    './geometry': { sidebarWidth: () => 64, minWindowTop: () => 96, TOP_BAR_HEIGHT: 28 },
    './chrome-layer': { ShellChromeLayer: class {} }, './text-input': textInput,
  });
  shell.isAssistantAvailable = () => false;
  shell.registerWindow({ windowId: 'term', appId: 'terminal', closeable: true, handleInput() {},
    receiveTextInput: (text) => typed.push(text) });
  shell.openSystemMenu('term');
  const menuLayer = shell.stack.layers.at(-1);
  const entry = menuLayer.items.find((item) => item.label === 'Text input');
  entry.onSelect({ stack: shell.stack, actions: layers.noopLayerActions });
  assert.ok(shell.stack.topMatches((layer) => layer instanceof textInput.TextInputLayer));
  assert.equal(shell.focus, 'window');
  let clock = 1_000_000;
  const send = (type) => shell.receiveInput({ ...gestures.makeInputEvent({ type, source: 'ring' }), timestampMs: clock += 600 });
  for (const type of ['scroll-up', 'scroll-down', 'long-press']) await send(type);   // H, a long-press through the shell
  for (const type of ['click', 'scroll-up', 'click']) await send(type);              // i
  for (const type of ['scroll-up', 'click', 'click', 'short-then-long-press']) await send(type); // e, deleted
  for (const type of ['double-click', 'double-click', 'click']) await send(type);    // menu, Type Into App
  assert.deepEqual(plain(typed), ['Hi']);
  assert.ok(shell.stack.isAtBase());
});

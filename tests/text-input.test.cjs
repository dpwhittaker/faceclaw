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

/** Every key under a node with the gestures it takes from there: each level is one move, and entering a key types it. */
function keyCosts(node, spent = 0, out = []) {
  if (node.kind === 'key') {
    out.push({ key: node, text: node.text, shifted: kb.shiftedText(node), gestures: spent });
    return out;
  }
  for (const child of node.children) if (child) keyCosts(child, spent + 1, out);
  return out;
}

function groups(node, out = []) {
  if (node.kind === 'group') {
    out.push(node);
    for (const child of node.children) if (child) groups(child, out);
  }
  return out;
}

/** Each key's route as moves: S for a swipe (top or bottom box), T for a tap (middle). */
function routes(node, route = '', out = {}) {
  if (node.kind === 'key') { out[node.text] = route; return out; }
  node.children.forEach((child, slot) => { if (child) routes(child, route + (slot === kb.SLOT_MIDDLE ? 'T' : 'S'), out); });
  return out;
}

test('the letters are a-z and space, three moves each, the commonest on the routes with fewest taps', () => {
  const costs = keyCosts(kb.LETTERS);
  assert.equal(costs.length, 27);
  assert.deepEqual(costs.map((c) => c.text).sort(), [...' abcdefghijklmnopqrstuvwxyz']);
  assert.ok(costs.every((c) => c.gestures === 3));
  const route = routes(kb.LETTERS);
  const withRoute = (...patterns) => Object.keys(route).filter((ch) => patterns.includes(route[ch])).sort().join('');
  assert.equal(withRoute('SSS'), ' aeinost');                              // the eight commonest: no taps
  assert.equal(withRoute('TSS', 'STS', 'SST'), 'cdfghlmpruwy');            // one tap
  assert.equal(withRoute('TST'), 'bv');                                    // two taps a swipe apart
  assert.equal(withRoute('TTS', 'STT'), 'jkqx');                           // two taps in a row could read as a double-tap
  assert.equal(withRoute('TTT'), 'z');
  assert.equal(route[' '], 'SSS');
  // Shift gives the capitals; space has no twin.
  assert.equal(costs.find((c) => c.text === 'q').shifted, 'Q');
  assert.equal(costs.find((c) => c.text === ' ').shifted, ' ');
});

test('the commonest punctuation keys are single-tap corners of their box', () => {
  const route = routes(kb.KEYBOARD_ROOT.children[kb.SLOT_TOP]);
  for (const char of ',.\'-') assert.equal(route[char], 'TSS', char);
});

test('all of printable ASCII, Enter and Tab sit on 23 QWERTY keys at most four moves from the root, numbers and punctuation on top', () => {
  const top = keyCosts(kb.KEYBOARD_ROOT.children[kb.SLOT_TOP], 1);
  assert.equal(top.length, 23);
  assert.ok(top.every((c) => c.gestures === (c.text === '\n' || c.text === '\t' ? 3 : 4)));
  const typed = new Set(keyCosts(kb.KEYBOARD_ROOT).flatMap((c) => [c.text, c.shifted]));
  for (let code = 0x20; code <= 0x7e; code++) assert.ok(typed.has(String.fromCharCode(code)), String.fromCharCode(code));
  assert.ok(typed.has('\n')); assert.ok(typed.has('\t'));
  // US keyboard pairs.
  const pair = (char) => top.find((c) => c.text === char)?.shifted;
  for (const [base, shifted] of ['1!', '2@', '3#', '4$', '5%', '6^', '7&', '8*', '9(', '0)', '`~', '-_', '=+', '[{', ']}', '\\|', ';:', '\'"', ',<', '.>', '/?']) {
    assert.equal(pair(base), shifted, base);
  }
  assert.equal(kb.KEYBOARD_ROOT.children[kb.SLOT_MIDDLE], kb.LETTERS);
  // The bottom set reaches well past ASCII and is the deepest.
  const more = keyCosts(kb.KEYBOARD_ROOT.children[kb.SLOT_BOTTOM]);
  for (const char of ['é', '€', '→', '┼', '★', 'ω', 'ж', 'あ', 'ア', '。']) {
    assert.ok(more.some((c) => c.text === char), char);
  }
  assert.equal(more.find((c) => c.text === 'ж').shifted, 'Ж');
  assert.equal(more.find((c) => c.text === 'ß').shifted, 'ß'); // its capital would be two letters
  assert.ok(kb.nodeDepth(kb.KEYBOARD_ROOT.children[kb.SLOT_BOTTOM]) > kb.nodeDepth(kb.KEYBOARD_ROOT.children[kb.SLOT_TOP]));
});

test('every group offers at least two boxes and every key types single characters', () => {
  for (const group of groups(kb.KEYBOARD_ROOT)) {
    assert.equal(group.children.length, 3);
    assert.ok(group.children.filter(Boolean).length >= 2, group.label ?? JSON.stringify(group.children));
  }
  for (const { text, shifted } of keyCosts(kb.KEYBOARD_ROOT)) {
    assert.equal(Array.from(text).length, 1, text);
    assert.equal(Array.from(shifted).length, 1, shifted);
  }
});

test('the cursor opens at the letters, types a key by entering it, and returns to the letters (digits to the numbers)', () => {
  const k = new kb.TrinaryKeyboard();
  assert.ok(k.isAtHome()); assert.deepEqual(plain(k.trail()), ['Letters']);
  const type = (...moves) => {
    let outcome;
    for (const move of moves) {
      const shifted = move.endsWith('!');
      const name = move.replace('!', '');
      outcome = name === 'up' ? k.zoom(kb.SLOT_TOP, shifted) : name === 'down' ? k.zoom(kb.SLOT_BOTTOM, shifted) : k.tap(shifted);
    }
    return outcome;
  };
  assert.deepEqual(plain(type('down', 'down', 'up')), { kind: 'typed', text: 't' });
  assert.ok(k.isAtHome());
  assert.deepEqual(plain(type('tap', 'up', 'up')), { kind: 'typed', text: 'h' });
  // Swiping into a side key types it: no confirming tap.
  assert.deepEqual(plain(type('up', 'up')), { kind: 'moved' });
  assert.deepEqual(plain(type('up')), { kind: 'typed', text: 'a' });
  assert.deepEqual(plain(type('up', 'up', 'down!')), { kind: 'typed', text: 'E' });
  assert.deepEqual(plain(type('down', 'down', 'down')), { kind: 'typed', text: ' ' });
  assert.deepEqual(plain(type('tap', 'tap', 'tap')), { kind: 'typed', text: 'z' });
  // Double-tap zooms out to the root, then has nowhere further to go.
  k.zoom(kb.SLOT_TOP);
  assert.equal(k.back(), true); assert.ok(k.isAtHome());
  assert.equal(k.back(), true); assert.ok(k.isAtRoot());
  assert.equal(k.back(), false);
  // A digit returns to numbers and punctuation, ready for the next digit or a decimal point.
  assert.deepEqual(plain(type('up', 'up', 'tap', 'tap')), { kind: 'typed', text: '5' });
  assert.deepEqual(plain(k.trail()), ['Numbers & punctuation']);
  assert.deepEqual(plain(type('tap', 'down', 'tap')), { kind: 'typed', text: '0' });
  assert.deepEqual(plain(k.trail()), ['Numbers & punctuation']);
  assert.deepEqual(plain(type('tap', 'up', 'down')), { kind: 'typed', text: '.' });
  assert.ok(k.isAtHome());
  // Shifted, a digit key types its symbol, which returns to the letters.
  k.back();
  assert.deepEqual(plain(type('up', 'up', 'up', 'up!')), { kind: 'typed', text: '!' });
  assert.ok(k.isAtHome());
  k.back();
  assert.deepEqual(plain(type('up', 'down', 'tap')), { kind: 'typed', text: '\n' });
  k.back();
  assert.deepEqual(plain(type('up', 'down', 'down')), { kind: 'typed', text: '\t' });
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
  const at = (type, gapMs = 600, source = 'ring') => ({ ...gestures.makeInputEvent({ type, source }), timestampMs: clock += gapMs });
  const input = async (...types) => {
    for (const type of types) await stack.handleInput(at(type));
  };
  return { stack, layer, sent, input, at, closed: () => closed, renders: () => renders };
}

test('the dialog types with the ring, long-press shifts once, twice locks, a third turns it off; tap-then-hold deletes', async () => {
  const d = dialog();
  assert.equal(d.layer.acceptsHoldGestures, true);
  await d.input('long-press', 'click', 'scroll-up', 'scroll-up');     // shift, H
  await d.input('scroll-down', 'click', 'scroll-up');                 // u: swiping into it types it
  await d.input('ring-press');                                        // ignored
  assert.equal(d.layer.getText(), 'Hu');
  await d.input('short-then-long-press');
  await d.input('scroll-up', 'scroll-down', 'scroll-up');             // i
  assert.equal(d.layer.getText(), 'Hi');
  await d.input('long-press', 'long-press');                          // caps lock
  await d.input('scroll-up', 'scroll-up', 'scroll-up');               // A
  await d.input('click', 'scroll-up', 'click');                       // B, still locked
  await d.input('long-press');                                        // off
  await d.input('scroll-up', 'scroll-up', 'click');                   // c
  assert.equal(d.layer.getText(), 'HiABc');
  await d.input('long-press', 'scroll-down', 'scroll-down', 'scroll-down'); // shift, space: shift spent on it
  await d.input('scroll-up', 'scroll-up', 'scroll-down');             // e, unshifted
  assert.equal(d.layer.getText(), 'HiABc e');
  for (let i = 0; i < 7; i++) await d.input('short-then-long-press');
  assert.equal(d.layer.getText(), '');
});

test('each touch starts a new swipe however fast; the extra reports of one R1 swipe are dropped', async () => {
  const d = dialog();
  const send = (type, gapMs, source) => d.stack.handleInput(d.at(type, gapMs, source));
  await send('ring-press', 600); await send('scroll-up', 150);   // into b a c / d e f / g h j
  await send('scroll-up', 90); await send('scroll-up', 90);      // the ring repeating that swipe
  await send('ring-press', 60); await send('scroll-down', 100);  // a new touch, 160 ms after the last report: i g n
  await send('click', 400);                                      // g, the middle key
  assert.equal(d.layer.getText(), 'g');
});

test('a repeat of the swipe that typed a key types nothing more', async () => {
  const d = dialog();
  const send = (type, gapMs) => d.stack.handleInput(d.at(type, gapMs));
  await send('ring-press', 600); await send('scroll-up', 150);   // a c e / d j f / i g n
  await send('ring-press', 600); await send('scroll-down', 150); // i g n
  await send('ring-press', 600); await send('scroll-up', 150);   // i
  await send('scroll-up', 90); await send('scroll-up', 90);      // the ring repeating that swipe
  assert.equal(d.layer.getText(), 'i');
  assert.ok(d.layer.keyboard.isAtHome());
});

test('without ring-press a ring swipe is new once the last report is 250 ms old; watch swipes are never dropped', async () => {
  const d = dialog();
  const send = (type, gapMs, source) => d.stack.handleInput(d.at(type, gapMs, source));
  await send('scroll-up', 600); await send('scroll-up', 90);     // firmware without ring-press: a swipe and a repeat
  await send('scroll-down', 600); await send('click', 600);      // i g n, then g
  // The watch: up, up (top box, then its top row), right types the middle key.
  await send('swipe-up', 600, 'watch'); await send('swipe-up', 90, 'watch'); await send('swipe-right', 400, 'watch');
  assert.equal(d.layer.getText(), 'gc');
  await send('swipe-left', 600, 'watch');                        // back out to the root, as double-tap
  await send('swipe-left', 600, 'watch');                        // and on to the send menu
  await send('swipe-right', 600, 'watch');                       // Type Into App
  assert.deepEqual(plain(d.sent), [['app', 'gc']]);
});

test('double-tap past the root opens the menu; double-tap there keeps typing; a send delivers the trimmed text', async () => {
  const d = dialog();
  await d.input('scroll-up', 'scroll-up', 'scroll-down', 'double-click'); // e, then out to the root
  await d.input('double-click');                                      // menu
  // An empty send row would do nothing, but there is text: double-tap returns to the letters.
  await d.input('double-click');
  await d.input('scroll-down', 'scroll-down', 'scroll-down');         // space
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
  await d.input('long-press'); check();                                // shifted: Ii Gg Nn
  await d.input('scroll-up'); check();                                 // I typed, back at the letters
  await d.input('scroll-up', 'double-click', 'double-click'); check(); // the root
  await d.input('scroll-up', 'scroll-down'); check();                  // Enter and Tab, large
  await d.input('double-click', 'double-click'); check();              // the root again
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
  await send('ring-press');
  assert.equal(shell.stack.layers.at(-1).touchedSinceSwipe, true);                     // the shell routed the touch to the keyboard
  for (const type of ['long-press', 'click', 'scroll-up', 'scroll-up']) await send(type); // shift (through the shell), H
  for (const type of ['scroll-up', 'scroll-down', 'scroll-up']) await send(type);    // i
  for (const type of ['scroll-up', 'scroll-up', 'scroll-down', 'short-then-long-press']) await send(type); // e, deleted
  for (const type of ['double-click', 'double-click', 'click']) await send(type);    // menu, Type Into App
  assert.deepEqual(plain(typed), ['Hi']);
  assert.ok(shell.stack.isAtBase());
});

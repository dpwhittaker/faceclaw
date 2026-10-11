const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Shell.openModal and the closer it hands back, lifted out of shell.ts on their own.
function modalMethods(played) {
  const source = ts.createSourceFile('shell.ts', fs.readFileSync(path.join(__dirname, '..', 'app/ui/shell/shell.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const shell = source.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === 'Shell');
  const methods = shell.members.filter((s) => ['openModal', 'closeNotificationModal'].includes(s.name?.getText(source)));
  const js = ts.transpileModule('export class Shell {\n' + methods.map((s) => s.getText(source)).join('\n') + '\n}', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const context = { exports: {}, console, setTimeout,
    ShellModalLayer: class { constructor(layer) { this.layer = layer; } },
    playSoundEffect: async (effect, play) => { played.push(effect.name); await play(new Uint8Array([5, 4, 0])); } };
  vm.runInNewContext(js, context);
  return context.exports.Shell;
}

function shellAt(screenOn, played, sent) {
  const Shell = modalMethods(played);
  const s = new Shell();
  const stack = [];
  Object.assign(s, {
    screenOn,
    wake() { if (this.screenOn) return false; this.screenOn = true; return true; },
    sleep() { this.screenOn = false; },
    stack: { push: (layer) => stack.push(layer), popIfTop: (match) => { if (match(stack.at(-1))) stack.pop(); } },
    config: { actions: { playBuzzerSequence: (payload) => sent.push(payload) }, requestShellRender() {} },
  });
  return { s, stack };
}

test('a pop-up wakes a dark screen, plays its sound, and puts the screen back to sleep when closed', async () => {
  const played = [], sent = [];
  const { s, stack } = shellAt(false, played, sent);
  const close = s.openModal({}, { name: 'notify', make: () => [] });
  assert.equal(s.screenOn, true);
  assert.equal(stack.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(played, ['notify']);
  assert.equal(sent.length, 1, 'through the glasses speaker');
  close();
  assert.equal(s.screenOn, false);
  assert.equal(stack.length, 0);
});

test('a pop-up over a lit screen leaves it on when closed, and without a sound plays none', async () => {
  const played = [], sent = [];
  const { s } = shellAt(true, played, sent);
  const close = s.openModal({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(played, []);
  close();
  assert.equal(s.screenOn, true);
});

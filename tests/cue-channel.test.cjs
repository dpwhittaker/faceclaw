const test = require("node:test");
const assert = require("node:assert/strict");

const { CueChannel } = require("../.test-build/app/apps/cue/cue-channel.js");

function harness() {
  const sockets = [];
  const timers = [];
  const events = { status: [], lists: [], popups: [], ends: [], answers: [], recent: [] };
  const channel = new CueChannel(
    (url, token, handlers) => {
      const socket = { url, token, handlers, sent: [], open: true, send(text) { if (!this.open) return false; this.sent.push(JSON.parse(text)); return true; }, close() { this.open = false; } };
      sockets.push(socket);
      return socket;
    },
    {
      onStatus: (status, detail) => events.status.push([status, detail]),
      onRecent: (recent) => events.recent.push(recent),
      onList: (contextId, items) => events.lists.push([contextId, items]),
      onPopup: (popup) => events.popups.push(popup),
      onEndContext: (contextId, reason) => events.ends.push([contextId, reason]),
      onAnswer: (askId, text, done) => events.answers.push([askId, text, done]),
    },
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    () => {},
  );
  const last = () => sockets[sockets.length - 1];
  return {
    channel, sockets, timers, events, last,
    types: (socket = last()) => socket.sent.map((f) => f.type),
    reply: (frame, socket = last()) => socket.handlers.onMessage(JSON.stringify(frame)),
    drop: (socket = last()) => { socket.open = false; socket.handlers.onClose("offline"); },
    retry: () => timers.shift().fn(),
  };
}

const context = { atMs: 1, contextId: "c1", kind: "adhoc" };

test("a new session starts, and frames go straight out while connected", () => {
  const h = harness();
  h.channel.start("ws://backend", "secret", "s1", "work");
  assert.equal(h.last().token, "secret");
  h.last().handlers.onOpen();
  h.channel.switchTo(context);
  h.channel.line("c1", "Voice 1", "hello", 10, 20);
  assert.deepEqual(h.types(), ["session-start", "switch", "line"]);
  assert.deepEqual(h.last().sent[0], { type: "session-start", org: "work", sessionId: "s1" });
  assert.equal(h.last().sent[2].seq, 0);
});

test("after a drop, the channel resumes and resends only what wasn't acked", () => {
  const h = harness();
  h.channel.start("ws://backend", "t", "s1", "work");
  h.last().handlers.onOpen();
  h.channel.switchTo(context);
  h.channel.line("c1", "Voice 1", "one", 1, 2);
  h.channel.line("c1", "Voice 1", "two", 3, 4);
  h.reply({ type: "ack", seq: 0 });
  h.drop();
  h.channel.line("c1", "Voice 2", "three", 5, 6);
  h.channel.ask("c1", "a1", "rfc", "More?");
  h.retry();
  h.last().handlers.onOpen();
  assert.deepEqual(h.types(), ["resume"], "nothing else until the backend answers");
  assert.equal(h.last().sent[0].lastAckedSeq, 0);
  h.reply({ type: "ack", seq: 1 });
  assert.deepEqual(h.types(), ["resume", "ask", "line"]);
  assert.equal(h.last().sent[2].text, "three");
});

test("a backend that forgot the session gets a new start and the current context again", () => {
  const h = harness();
  h.channel.start("ws://backend", "t", "s1", "work");
  h.last().handlers.onOpen();
  h.channel.switchTo(context);
  h.channel.line("c1", "Voice 1", "one", 1, 2);
  h.drop();
  h.retry();
  h.last().handlers.onOpen();
  h.reply({ type: "error", message: "unknown session; start a new one" });
  assert.deepEqual(h.types(), ["resume", "session-start", "switch", "line"]);
});

test("reconnect waits back off to 30 seconds", () => {
  const h = harness();
  h.channel.start("ws://backend", "t", "s1", "");
  const delays = [];
  for (let i = 0; i < 7; i++) {
    h.drop();
    delays.push(h.timers[0].ms);
    h.retry();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(h.events.status.at(-1)[0], "connecting");
});

test("backend frames reach the app", () => {
  const h = harness();
  h.channel.start("ws://backend", "t", "s1", "");
  h.last().handlers.onOpen();
  h.reply({ type: "session-ack", recent: [{ personId: "priya", name: "Priya", team: "", lastTalked: 5 }] });
  h.reply({ type: "list", contextId: "c1", rev: 1, items: [{ id: "x", rank: 1, title: "T", detail: "", label: "" }] });
  h.reply({ type: "popup", id: "p", title: "Heads up", lines: ["a"], priority: "high", seconds: 8 });
  h.reply({ type: "end-context", contextId: "c1", reason: "wrap-up" });
  h.reply({ type: "answer", askId: "a1", text: "Because.", done: true });
  assert.equal(h.events.recent[0][0].name, "Priya");
  assert.equal(h.events.lists[0][1][0].id, "x");
  assert.equal(h.events.popups[0].seconds, 8);
  assert.deepEqual(h.events.ends[0], ["c1", "wrap-up"]);
  assert.deepEqual(h.events.answers[0], ["a1", "Because.", true]);
});

test("stopping says goodbye and drops what's waiting", () => {
  const h = harness();
  h.channel.start("ws://backend", "t", "s1", "");
  h.last().handlers.onOpen();
  const socket = h.last();
  h.channel.stop();
  assert.equal(socket.sent.at(-1).type, "session-end");
  assert.equal(socket.open, false);
  h.channel.line("c1", "Voice 1", "ignored", 1, 2);
  assert.equal(socket.sent.at(-1).type, "session-end");
});

test("a failure followed by a close schedules one retry", () => {
  const h = harness();
  h.channel.start("ws://backend", "t", "s1", "");
  const socket = h.last();
  socket.handlers.onClose("failed");
  socket.handlers.onClose("closed");
  assert.equal(h.timers.length, 1);
});

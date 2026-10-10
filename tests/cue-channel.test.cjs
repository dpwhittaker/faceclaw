const test = require("node:test");
const assert = require("node:assert/strict");

const { CueChannel } = require("../.test-build/app/apps/cue/cue-channel.js");

function harness() {
  const sockets = [];
  const timers = [];
  const events = { status: [], cues: [], ends: [], answers: [], recent: [] };
  const channel = new CueChannel(
    (url, token, handlers) => {
      const socket = { url, token, handlers, sent: [], open: true, send(text) { if (!this.open) return false; this.sent.push(JSON.parse(text)); return true; }, close() { this.open = false; } };
      sockets.push(socket);
      return socket;
    },
    {
      onStatus: (status, detail) => events.status.push([status, detail]),
      onRecent: (recent) => events.recent.push(recent),
      onCue: (cue) => events.cues.push(cue),
      onEndContext: (contextId, reason) => events.ends.push([contextId, reason]),
      onAnswer: (askId, text, done) => events.answers.push([askId, text, done]),
      onTriage: (triage) => (events.triage ??= []).push(triage),
      onReplies: (nid, replies) => (events.replies ??= []).push([nid, replies]),
      onNotebooks: (notebooks) => (events.notebooks ??= []).push(notebooks),
      onContextAck: (contextId, candidates) => (events.acks ??= []).push([contextId, candidates]),
      onSpeaker: (speaker) => (events.speakers ??= []).push(speaker),
      onMemoryUpdated: (update) => (events.memory ??= []).push(update),
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

test("the main screen's size goes to the backend, and again to a restarted backend's new session", () => {
  const h = harness();
  h.channel.start("ws://backend", "t", "s1", "work");
  h.last().handlers.onOpen();
  h.channel.screen(99, 28);
  assert.deepEqual(h.last().sent.at(-1), { type: "screen", columns: 99, lines: 28, sessionId: "s1" });
  h.drop();
  h.retry();
  h.last().handlers.onOpen();
  h.reply({ type: "error", message: "unknown session; start a new one" });
  assert.deepEqual(h.types(), ["resume", "session-start", "screen"]);
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
  h.reply({ type: "cue", contextId: "c1", notebook: "work", entryId: "c:c1/x", category: "urgent", line: "That's Dana", title: "1:1 with Tom", detail: "Tom's new lead" });
  h.reply({ type: "replies", nid: "m1", replies: ["Yes", "No"] });
  h.reply({ type: "end-context", contextId: "c1", reason: "wrap-up" });
  h.reply({ type: "answer", askId: "a1", text: "Because.", done: true });
  assert.equal(h.events.recent[0][0].name, "Priya");
  assert.deepEqual([h.events.cues[0].entryId, h.events.cues[0].category, h.events.cues[0].detail], ["c:c1/x", "urgent", "Tom's new lead"]);
  assert.deepEqual(h.events.replies[0], ["m1", ["Yes", "No"]]);
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

test("notifications queue while offline, and triage and notebooks frames come back", () => {
  const h = harness();
  h.channel.start("ws://backend", "t", "s1", "");
  h.channel.notification({ nid: "n1", package: "p", app: "App", profile: 0, postedMs: 1, title: "T", text: "x", bigText: "", subText: "", lines: [], messages: [] });
  h.last().handlers.onOpen();
  assert.deepEqual(h.types(), ["session-start", "notification"]);
  h.channel.entry("work", "n:n1", "move", "todo");
  h.channel.statusClear("work");
  assert.deepEqual(h.last().sent.slice(-2).map((f) => [f.type, f.notebook, f.to]), [["entry", "work", "todo"], ["status-clear", "work", undefined]]);
  h.reply({ type: "triage", nid: "n1", category: "urgent", notebook: "work", entryId: "n:n1", line: "L", title: "T", body: "B", app: "email" });
  h.reply({ type: "notebooks", notebooks: [{ name: "work" }] });
  assert.equal(h.events.triage[0].category, "urgent");
  assert.equal(h.events.notebooks[0][0].name, "work");
});

test("retargeting starts a fresh session on the new backend and re-announces the context", () => {
  const h = harness();
  h.channel.start("ws://old", "t1", "s1", "work");
  h.last().handlers.onOpen();
  h.channel.switchTo(context);
  h.channel.retarget("ws://new", "t2");
  assert.equal(h.last().url, "ws://new");
  h.last().handlers.onOpen();
  assert.deepEqual(h.types(), ["session-start", "switch"]);
});

test("voices: candidates and names come back; voice-prints, corrections and undo go out", () => {
  const h = harness();
  h.channel.start("ws://backend", "t", "s1", "work");
  h.channel.voiceprint("c1", "Voice 2", 8.53, [{ personId: "priya", similarity: 0.82 }]);
  h.last().handlers.onOpen();
  h.reply({ type: "context-ack", contextId: "c1", candidates: [{ personId: "priya", name: "Priya", tier: 1 }] });
  h.reply({ type: "speaker", contextId: "c1", speaker: "Voice 2", personId: "priya", name: "Priya", confidence: "medium", confirmed: false });
  h.reply({ type: "memory-updated", contextId: "c1", commit: "abc123", files: ["people/priya/notebook.md"], unknowns: [] });
  h.channel.correctSpeaker("c1", "Voice 3", null, "Dana");
  h.channel.review("abc123");
  assert.deepEqual(h.events.acks, [["c1", [{ personId: "priya", name: "Priya", tier: 1 }]]]);
  assert.equal(h.events.speakers[0].name, "Priya");
  assert.equal(h.events.speakers[0].confirmed, false);
  assert.equal(h.events.memory[0].commit, "abc123");
  const sent = h.last().sent.filter((f) => f.type !== "session-start");
  assert.deepEqual(sent.map((f) => f.type), ["voiceprint", "correct-speaker", "review"]);
  assert.equal(sent[0].seconds, 8.5);
  assert.deepEqual(sent[1], { type: "correct-speaker", contextId: "c1", speaker: "Voice 3", name: "Dana", sessionId: "s1" });
  assert.deepEqual(sent[2], { type: "review", commit: "abc123", action: "revert", sessionId: "s1" });
});

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ASK_GRACE_MS,
  CueContexts,
  PAUSED_GRACE_MS,
  SILENCE_END_MS,
} = require("../.test-build/app/apps/cue/contexts.js");

const MIN = 60 * 1000;
const at = (h, m = 0, s = 0) => Date.UTC(2026, 8, 28, h, m, s);

function meeting(id, title, startMs, endMs) {
  return {
    id, title, startMs, endMs, allDay: false, location: "", calendarName: "Work", description: "",
    organizer: "", selfStatus: "accepted", status: "confirmed", recurring: false, syncId: `ev${id}`,
    originalId: 0, originalSyncId: "", originalInstanceMs: 0, calendarId: 33, accountName: "me@example.com",
    ownerAccount: "me@example.com", attendees: [],
  };
}

function contexts() {
  let n = 0;
  return new CueContexts(() => `ctx${++n}`);
}

const summary = (changes) => changes.map((c) => `${c.type} ${c.context.id}${c.reason ? ` ${c.reason}` : ""}`);

test("the doc's example day: meeting, a call during it, back, then silence after it ran late", () => {
  const cue = contexts();
  const review = meeting(1, "Architecture review", at(9), at(10));
  // 9:00 speech during the review starts its context.
  assert.deepEqual(summary(cue.heard(at(9, 0, 5), review)), ["start ctx1"]);
  assert.equal(cue.current.kind, "scheduled");
  // 9:20 Priya calls: New conversation pauses the review.
  assert.deepEqual(summary(cue.switchTo({ type: "new" }, at(9, 20))), ["pause ctx1", "start ctx2"]);
  assert.deepEqual(cue.paused.map((c) => c.id), ["ctx1"]);
  // 9:31 back to the review: the ad-hoc call ends and the review resumes as a second part.
  assert.deepEqual(summary(cue.switchTo({ type: "paused", contextId: "ctx1" }, at(9, 31))), ["end ctx2 switched", "resume ctx1"]);
  assert.equal(cue.current.parts.length, 2);
  assert.deepEqual(cue.current.parts[0], { startMs: at(9, 0, 5), endMs: at(9, 20) });
  // The review runs late, past its 10:00 end; the last words are at 10:22:30.
  cue.heard(at(10, 22, 30), null);
  assert.deepEqual(cue.tick(at(10, 23)), []);
  const ended = cue.tick(at(10, 22, 30) + SILENCE_END_MS);
  assert.deepEqual(summary(ended), ["end ctx1 silence"]);
  // It ends at the last words, not when the silence was noticed.
  assert.equal(ended[0].atMs, at(10, 22, 30));
  assert.equal(cue.current, null);
});

test("with nothing current, speech starts an ad-hoc context when no meeting is on", () => {
  const cue = contexts();
  assert.deepEqual(summary(cue.heard(at(11, 40), null)), ["start ctx1"]);
  assert.equal(cue.current.kind, "adhoc");
});

test("silence before a meeting's end asks first; speech clears the question", () => {
  const cue = contexts();
  const standup = meeting(1, "Standup", at(9), at(9, 30));
  cue.heard(at(9, 1), standup);
  const asked = cue.tick(at(9, 1) + SILENCE_END_MS);
  assert.deepEqual(summary(asked), ["ask-ended ctx1"]);
  assert.equal(cue.askingEnded, true);
  // Screen sharing ends and people talk again.
  assert.deepEqual(summary(cue.heard(at(9, 3), standup)), ["ask-ended-cleared ctx1"]);
  assert.equal(cue.askingEnded, false);
  assert.equal(cue.current.id, "ctx1");
});

test("an unanswered question ends the meeting after the grace period, at the last words", () => {
  const cue = contexts();
  const standup = meeting(1, "Standup", at(9), at(9, 30));
  cue.heard(at(9, 10), standup);
  const askedAt = at(9, 10) + SILENCE_END_MS;
  cue.tick(askedAt);
  assert.deepEqual(cue.tick(askedAt + ASK_GRACE_MS - 1), []);
  const ended = cue.tick(askedAt + ASK_GRACE_MS);
  assert.deepEqual(summary(ended), ["ask-ended-cleared ctx1", "end ctx1 silence"]);
  assert.equal(ended[1].atMs, at(9, 10));
});

test("answering the question ends the meeting and clears the pop-up", () => {
  const cue = contexts();
  cue.heard(at(9, 10), meeting(1, "Standup", at(9), at(9, 30)));
  cue.tick(at(9, 10) + SILENCE_END_MS);
  assert.deepEqual(summary(cue.end(at(9, 12), "user")), ["ask-ended-cleared ctx1", "end ctx1 user"]);
});

test("an ended meeting doesn't restart on speech, but can be picked again", () => {
  const cue = contexts();
  const review = meeting(1, "Review", at(9), at(10));
  cue.heard(at(9, 5), review);
  cue.end(at(9, 40), "claude");
  assert.deepEqual(summary(cue.heard(at(9, 45), review)), ["start ctx2"]);
  assert.equal(cue.current.kind, "adhoc");
  const picked = cue.switchTo({ type: "event", event: review }, at(9, 46));
  assert.deepEqual(summary(picked), ["end ctx2 switched", "start ctx3"]);
  assert.equal(cue.current.kind, "scheduled");
});

test("speech during a paused meeting's slot, with nothing current, resumes it", () => {
  const cue = contexts();
  const review = meeting(1, "Review", at(9), at(10));
  cue.heard(at(9, 5), review);
  cue.switchTo({ type: "new" }, at(9, 20));
  cue.end(at(9, 25), "user");
  assert.deepEqual(summary(cue.heard(at(9, 26), review)), ["resume ctx1"]);
});

test("picking the meeting that's already current does nothing", () => {
  const cue = contexts();
  const review = meeting(1, "Review", at(9), at(10));
  cue.heard(at(9, 5), review);
  assert.deepEqual(cue.switchTo({ type: "event", event: review }, at(9, 6)), []);
});

test("a paused meeting ends once it's well past its calendar end", () => {
  const cue = contexts();
  const review = meeting(1, "Review", at(9), at(10));
  cue.heard(at(9, 5), review);
  cue.switchTo({ type: "new", people: [{ personId: "priya", name: "Priya" }] }, at(9, 20));
  assert.deepEqual(cue.current.people, [{ personId: "priya", name: "Priya" }]);
  cue.heard(at(10, 29, 30), null); // the call is still going
  assert.deepEqual(cue.tick(at(10) + PAUSED_GRACE_MS - 1), []);
  const expired = cue.tick(at(10) + PAUSED_GRACE_MS);
  assert.deepEqual(summary(expired), ["end ctx1 expired"]);
  assert.equal(expired[0].atMs, at(9, 20));
  assert.equal(cue.current.id, "ctx2");
});

test("stopping Cue ends the current context and every paused meeting", () => {
  const cue = contexts();
  cue.heard(at(9, 5), meeting(1, "Review", at(9), at(10)));
  cue.switchTo({ type: "event", event: meeting(2, "Other", at(9), at(10)) }, at(9, 10));
  assert.deepEqual(summary(cue.stop(at(9, 15))), ["end ctx2 stopped", "end ctx1 stopped"]);
  assert.equal(cue.current, null);
  assert.equal(cue.paused.length, 0);
});

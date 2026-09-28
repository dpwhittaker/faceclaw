const test = require("node:test");
const assert = require("node:assert/strict");

const { CueContexts } = require("../.test-build/app/apps/cue/contexts.js");
const { contextTitle, switchChoices } = require("../.test-build/app/apps/cue/switch-choices.js");

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const at = (h, m = 0) => Date.UTC(2026, 8, 28, h, m);
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

function meeting(id, title, startMs, endMs) {
  return {
    id, title, startMs, endMs, allDay: false, location: "", calendarName: "Work", description: "",
    organizer: "", selfStatus: "accepted", status: "confirmed", recurring: false, syncId: `ev${id}`,
    originalId: 0, originalSyncId: "", originalInstanceMs: 0, calendarId: 33, accountName: "me@example.com",
    ownerAccount: "me@example.com", attendees: [],
  };
}

test("Switch lists meetings now, then paused meetings, then recent people and teams, leaving out the current one", () => {
  let n = 0;
  const cue = new CueContexts(() => `ctx${++n}`);
  const review = meeting(1, "Architecture review", at(9), at(10));
  const standup = meeting(2, "Standup", at(9), at(9, 30));
  const planning = meeting(3, "Planning", at(9, 33), at(10));
  cue.heard(at(9, 1), standup);
  cue.switchTo({ type: "event", event: review }, at(9, 10)); // standup paused
  const recent = [
    { kind: "person", id: "priya", name: "Priya", lastTalkedMs: at(9) - DAY },
    { kind: "team", id: "payments", name: "Payments", lastTalkedMs: at(9) - 2 * DAY,
      members: [{ personId: "tom", name: "Tom" }] },
    { kind: "person", id: "old", name: "Old friend", lastTalkedMs: at(9) - 8 * DAY },
  ];
  const choices = switchChoices([review, standup, planning], cue.paused, recent, cue.current, at(9, 30), hhmm);
  assert.deepEqual(choices.map((c) => c.label),
    ["Planning · 09:33", "Standup · paused 09:10", "Priya", "Payments"]);
  assert.deepEqual(choices[1].target, { type: "paused", contextId: "ctx1" });
  const team = choices[3].target;
  assert.deepEqual(team.team, { teamId: "payments", name: "Payments" });
  cue.switchTo(team, at(9, 31));
  assert.equal(contextTitle(cue.current), "Payments");
  assert.deepEqual(cue.current.people, [{ personId: "tom", name: "Tom" }]);
});

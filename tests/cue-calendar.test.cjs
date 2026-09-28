const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EARLY_JOIN_MS,
  currentEvent,
  eventsOnNow,
  occurrenceKey,
  seriesKey,
} = require("../.test-build/app/apps/cue/calendar-context.js");

const NOW = Date.UTC(2026, 8, 28, 15, 10); // Mon Sep 28 2026, 15:10 UTC
const MIN = 60 * 1000;

function event(overrides) {
  return {
    id: 1,
    title: "Meeting",
    startMs: NOW - 10 * MIN,
    endMs: NOW + 20 * MIN,
    allDay: false,
    location: "",
    calendarName: "me@example.com",
    description: "",
    organizer: "",
    selfStatus: "accepted",
    status: "confirmed",
    recurring: false,
    syncId: "",
    originalId: 0,
    originalSyncId: "",
    originalInstanceMs: 0,
    attendees: [],
    ...overrides,
  };
}

function attendee(email, overrides = {}) {
  return { name: email, email, type: "required", role: "attendee", status: "accepted", self: false, ...overrides };
}

test("a synced one-off event is keyed by its sync id", () => {
  const e = event({ id: 42, syncId: "abc123" });
  assert.equal(seriesKey(e), "abc123");
  assert.equal(occurrenceKey(e), "abc123");
});

test("a local event falls back to the Android id", () => {
  const e = event({ id: 42 });
  assert.equal(seriesKey(e), "android-42");
  assert.equal(occurrenceKey(e), "android-42");
});

test("recurring occurrences share the series key and differ by scheduled time", () => {
  const first = event({ syncId: "weekly", recurring: true, startMs: Date.UTC(2026, 8, 28, 15, 0) });
  const second = event({ syncId: "weekly", recurring: true, startMs: Date.UTC(2026, 9, 5, 15, 0) });
  assert.equal(seriesKey(first), "weekly");
  assert.equal(seriesKey(second), "weekly");
  assert.equal(occurrenceKey(first), "weekly_20260928T150000Z");
  assert.equal(occurrenceKey(second), "weekly_20261005T150000Z");
});

test("a moved occurrence keeps its series and its original occurrence key", () => {
  // Google stores a moved occurrence as its own row: its own sync id, the
  // series' id in originalSyncId, and the originally scheduled start.
  const moved = event({
    id: 77,
    syncId: "weekly_20260928T150000Z",
    originalId: 5,
    originalSyncId: "weekly",
    originalInstanceMs: Date.UTC(2026, 8, 28, 15, 0),
    recurring: true,
    startMs: Date.UTC(2026, 8, 28, 17, 30),
  });
  assert.equal(seriesKey(moved), "weekly");
  assert.equal(occurrenceKey(moved), "weekly_20260928T150000Z");
});

test("a moved occurrence of a local series links by the series' Android id", () => {
  const moved = event({ id: 77, originalId: 5, originalInstanceMs: Date.UTC(2026, 8, 28, 15, 0), recurring: true });
  assert.equal(seriesKey(moved), "android-5");
  assert.equal(occurrenceKey(moved), "android-5_20260928T150000Z");
});

test("all-day occurrences are keyed by date", () => {
  const e = event({ syncId: "standup", recurring: true, allDay: true, startMs: Date.UTC(2026, 8, 28) });
  assert.equal(occurrenceKey(e), "standup_20260928");
});

test("declined, canceled, all-day, ended and later events are not on now", () => {
  const events = [
    event({ id: 1, selfStatus: "declined" }),
    event({ id: 2, status: "canceled" }),
    event({ id: 3, allDay: true }),
    event({ id: 4, endMs: NOW }),
    event({ id: 5, startMs: NOW + EARLY_JOIN_MS + 1, endMs: NOW + 60 * MIN }),
    event({ id: 6, attendees: [attendee("me@example.com", { self: true, status: "declined" })] }),
  ];
  assert.deepEqual(eventsOnNow(events, NOW), []);
  assert.equal(currentEvent(events, NOW), null);
});

test("a meeting starting within the early-join window is listed after ones under way", () => {
  const underWay = event({ id: 1 });
  const soon = event({ id: 2, startMs: NOW + 3 * MIN, endMs: NOW + 33 * MIN });
  assert.deepEqual(eventsOnNow([soon, underWay], NOW).map((e) => e.id), [1, 2]);
});

test("the meeting you're required at wins over one you're optional at", () => {
  const optional = event({
    id: 1,
    startMs: NOW - 2 * MIN,
    attendees: [attendee("boss@example.com"), attendee("me@example.com", { self: true, type: "optional" })],
  });
  const required = event({
    id: 2,
    startMs: NOW - 8 * MIN,
    attendees: [attendee("priya@example.com"), attendee("me@example.com", { self: true })],
  });
  assert.equal(currentEvent([optional, required], NOW).id, 2);
});

test("your own guest-free event counts as required; someone else's meeting does not", () => {
  const mine = event({ id: 1, title: "D&D", startMs: NOW - 30 * MIN });
  const notInvited = event({ id: 2, startMs: NOW - 5 * MIN, attendees: [attendee("lee@example.com")] });
  assert.equal(currentEvent([notInvited, mine], NOW).id, 1);
});

test("among equals, the most recently started meeting wins over the block around it", () => {
  const block = event({ id: 1, startMs: NOW - 70 * MIN, endMs: NOW + 110 * MIN });
  const call = event({ id: 2, startMs: NOW - 5 * MIN, endMs: NOW + 25 * MIN });
  assert.equal(currentEvent([block, call], NOW).id, 2);
});

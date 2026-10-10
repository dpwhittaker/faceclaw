const test = require("node:test");
const assert = require("node:assert/strict");

const { notificationId, parseInvitation, routeNotification } = require("../.test-build/app/apps/cue/meeting-notifications.js");
const { normalizeTitle, planMeeting } = require("../.test-build/app/apps/cue/meeting-sync.js");
const { applyLocally, cueLine, entryOptions, entryRows, idleNotebookNames, rowWindow } = require("../.test-build/app/apps/cue/notebook-view.js");
const { parseResponses } = require("../.test-build/app/apps/cue/notification-responses.js");

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NNBSP = " ";

function notification(overrides) {
  return {
    key: "10|com.microsoft.office.outlook|1|t|1", profile: 10, package: "com.microsoft.office.outlook", app: "Outlook",
    postTime: local(2026, 9, 28, 8, 11), when: 0, category: "email", channelId: "v2.MAIL:account_x@example.com",
    title: "", text: "", bigText: "", subText: "", conversationTitle: "", lines: [], messages: [], actions: [],
    ...overrides,
  };
}

const invitation = (bigText, postTime) => notification({ title: "Ivana Muzaric", bigText, postTime, actions: ["Yes", "Maybe", "No"] });

test("invitations: today, tomorrow, a weekday date, a date with a year, and hours plus minutes", () => {
  const posted = local(2026, 9, 28, 8, 11); // a Monday
  const cases = [
    [`Power Bi to Palantir data source refresh fail\nTomorrow at 9:30${NNBSP}AM (30m)\nMicrosoft Teams Meeting\nCant find the ticket.`, local(2026, 9, 29, 9, 30), 30],
    [`Discuss AOI Changes\nToday at 12${NNBSP}PM (30m)\nMicrosoft Teams Meeting\n`, local(2026, 9, 28, 12, 0), 30],
    [`Final Plan Review -  Fraud ART PI Planning 2026.4\nThu, Oct 1, 1${NNBSP}PM (1h)\nMicrosoft Teams Meeting\nOur goal`, local(2026, 10, 1, 13, 0), 60],
    [`BSA/AML PI 2026.3 Inspect and Adapt\nThu, Oct 8, 8:30${NNBSP}AM (1h 30m)\nMicrosoft Teams Meeting\n`, local(2026, 10, 8, 8, 30), 90],
    [`FW: GitHub CoPilot Office Hours\nMon, Nov 10, 2025, 1${NNBSP}PM (30m)\nMicrosoft Teams Meeting\n-----Original`, local(2025, 11, 10, 13, 0), 30],
  ];
  for (const [bigText, start, minutes] of cases) {
    const meeting = parseInvitation(invitation(bigText, posted));
    assert.equal(meeting.startMs, start, bigText.split("\n")[0]);
    assert.equal(meeting.endMs - meeting.startMs, minutes * 60_000);
    assert.equal(meeting.location, "Microsoft Teams Meeting");
  }
  assert.equal(parseInvitation(invitation("Offsite\nThu, Oct 1 (All day)\nHQ", posted)), null);
});

test("a date in January posted in December is next year's", () => {
  const meeting = parseInvitation(invitation(`Kickoff\nTue, Jan 5, 10${NNBSP}AM (1h)\nHQ`, local(2026, 12, 20, 9, 0)));
  assert.equal(new Date(meeting.startMs).getFullYear(), 2027);
});

test("routing: reminders and invitations are meetings, an unreadable invitation is triaged, the rest triage", () => {
  const reminder = notification({
    channelId: "v2.EVENT_REMINDER:account_x", title: "CAB Review", text: `9:00${NNBSP}AM - 10:30${NNBSP}AM, Microsoft Teams Meeting`,
    when: local(2026, 9, 28, 9, 0), postTime: local(2026, 9, 28, 8, 45),
  });
  const routed = routeNotification(reminder);
  assert.equal(routed.kind, "meeting");
  assert.deepEqual([routed.meeting.title, routed.meeting.endMs - routed.meeting.startMs, routed.meeting.location], ["CAB Review", 90 * 60_000, "Microsoft Teams Meeting"]);
  assert.equal(routeNotification(notification({ channelId: "v2.EVENT_REMINDER:account_x" })).kind, "ignore", "an empty reminder summary");
  assert.equal(routeNotification(invitation("Something\nsoon-ish\nRoom 4", 0)).kind, "triage");
  const started = routeNotification(notification({ package: "com.microsoft.teams", channelId: "com.microsoft.teams.MeetingNotifications", title: "ED Daily Team Sync", text: "Teams meeting has started", postTime: 5 }));
  assert.deepEqual([started.kind, started.meeting.source, started.meeting.startMs], ["meeting", "started", 5]);
  assert.equal(routeNotification(notification({ title: "Jeff Rose", text: "FYI" })).kind, "triage");
});

test("the notification id is stable for a repost and changes with the content", () => {
  const a = notification({ title: "Priya", text: "Can you look?" });
  assert.equal(notificationId(a), notificationId({ ...a, key: "other", postTime: 99 }));
  assert.notEqual(notificationId(a), notificationId({ ...a, text: "Never mind" }));
});

test("meetings: create, skip what's there or past, and move a rescheduled invitation", () => {
  const now = local(2026, 9, 28, 8, 0);
  const meeting = { source: "invitation", title: "Discuss AOI Changes", startMs: local(2026, 9, 29, 11, 0), endMs: local(2026, 9, 29, 11, 30), location: "", description: "" };
  assert.deepEqual(planMeeting(meeting, [], [], now), { action: "create" });
  assert.deepEqual(planMeeting({ ...meeting, endMs: now - 1 }, [], [], now), { action: "skip", reason: "past" });
  const existing = [{ id: 7, title: "RE: Discuss AOI changes", startMs: meeting.startMs, endMs: meeting.endMs }];
  assert.deepEqual(planMeeting({ ...meeting, source: "reminder" }, existing, [], now), { action: "skip", reason: "exists" });
  assert.deepEqual(planMeeting(meeting, existing, [], now), { action: "skip", reason: "unchanged" });
  const created = [{ eventId: 7, title: "Discuss AOI Changes", startMs: meeting.startMs, endMs: meeting.endMs, source: "invitation" }];
  const moved = { ...meeting, startMs: local(2026, 9, 28, 12, 0), endMs: local(2026, 9, 28, 12, 30) };
  assert.deepEqual(planMeeting(moved, existing, created, now), { action: "update", eventId: 7 });
  // A reminder for a meeting Cue made from a reminder never moves it.
  assert.deepEqual(planMeeting({ ...moved, source: "reminder" }, existing, [{ ...created[0], source: "reminder" }], now), { action: "create" });
});

test("Teams' started notice matches a meeting that started a little earlier", () => {
  const now = local(2026, 9, 28, 9, 5);
  const existing = [{ id: 3, title: "ED Daily Team Sync", startMs: local(2026, 9, 28, 9, 0), endMs: local(2026, 9, 28, 9, 15) }];
  const started = { source: "started", title: "ED Daily Team Sync", startMs: local(2026, 9, 28, 9, 4), endMs: local(2026, 9, 28, 9, 34), location: "", description: "" };
  assert.deepEqual(planMeeting(started, existing, [], now), { action: "skip", reason: "exists" });
  assert.equal(normalizeTitle("FW: [EXTERNAL] Cloud Cost Commercials Review"), "cloud cost commercials review");
});

function notebook(name, entries, status = []) {
  return { name, label: name[0].toUpperCase() + name.slice(1), entries, status, statusCount: status.length };
}
const entry = (id, category, day, text, extra = {}) => ({ id, section: category === "status" ? "status" : "day", day, category, firstCategory: category, text, nid: id, contextId: null, title: "", body: "", ...extra });
const cue = (id, category, text) => entry(`c:ctx/${id}`, category, category === "status" ? null : "2026-09-28", `${category === "status" ? "09-28 " : ""}10:00 ${text} · 1:1 with Tom`, { nid: null, contextId: "ctx", title: "1:1 with Tom" });

test("idle view: Work on weekdays 8-6, everything else combined otherwise", () => {
  const notebooks = [notebook("work", []), notebook("church", []), notebook("theater", []), notebook("general", [])];
  assert.deepEqual(idleNotebookNames(notebooks, local(2026, 9, 30, 9, 0)), ["work"]);
  assert.deepEqual(idleNotebookNames(notebooks, local(2026, 9, 30, 18, 0)), ["church", "theater", "general"]);
  assert.deepEqual(idleNotebookNames(notebooks, local(2026, 10, 3, 10, 0)), ["church", "theater", "general"], "Saturday");
});

test("rows: urgent, then todo, then what the memory run kept, newest day first, then the status line", () => {
  const church = notebook("church", [entry("c1", "todo", "2026-09-29", "18:00 Pastor Dan · lead prayer Sunday?")], [entry("s1", "status", null, "09-30 07:00 Church Center · Bulletin")]);
  const general = notebook("general", [{ ...entry("g2", null, "2026-09-30", "- dentist moved"), nid: null }, entry("g1", "urgent", "2026-09-29", "08:15 Amy · pick up Sam at 3"), entry("g3", "todo", "2026-09-30", "09:00 Pay the water bill")]);
  const rows = entryRows([church, general], ["church", "general"]);
  assert.deepEqual(rows.map((r) => r.text), ["‼ General: Amy · pick up Sam at 3", "◆ General: Pay the water bill", "◆ Church: Pastor Dan · lead prayer Sunday?", "  General: - dentist moved", "1 status message"]);
  assert.deepEqual(entryRows([church], ["church"]).map((r) => r.text)[0], "◆ Pastor Dan · lead prayer Sunday?");
});

test("in a conversation its cues come first, status ones too, from whichever notebook", () => {
  const work = notebook("work",
    [entry("w1", "urgent", "2026-09-28", "09:00 Ivana · refresh failed"), cue("rfc", "todo", "You owe Priya an RFC review"), cue("dana", "urgent", "That's Dana")],
    [cue("q4", "status", "Tom said Q4"), entry("s1", "status", null, "09-28 08:00 SailPoint · approved")]);
  const church = notebook("church", [entry("c1", "todo", "2026-09-27", "18:00 Pastor Dan · lead prayer?")]);
  const rows = entryRows([work, church], ["church"], "ctx");
  assert.deepEqual(rows.map((r) => r.text), ["‼ That's Dana", "◆ You owe Priya an RFC review", "○ Tom said Q4", "‼ Work: Ivana · refresh failed", "◆ Church: Pastor Dan · lead prayer?", "1 status message"],
    "the conversation's notebook (Work) shows beside Church");
  const atWork = entryRows([work], ["work"], "ctx");
  assert.deepEqual(atWork.map((r) => r.text).slice(3), ["‼ Ivana · refresh failed", "1 status message"], "the conversation's status cue isn't counted twice");
  assert.equal(cueLine(cue("rfc", "todo", "You owe Priya an RFC review")), "You owe Priya an RFC review");
});

test("a shelved status cue leaves the main screen for the status line; the conversation's notebook counts as shown", () => {
  const work = notebook("work", [], [{ ...cue("q4", "status", "Tom said Q4"), shelved: true }, cue("ledger", "status", "Ledger resumes this week"), entry("s1", "status", null, "09-28 08:00 SailPoint · approved")]);
  const general = notebook("general", [entry("g1", "todo", "2026-09-28", "09:00 Pay the water bill")]);
  const rows = entryRows([work, general], ["general"], "ctx");
  assert.deepEqual(rows.map((r) => [r.text, r.live ?? null]), [
    ["○ Ledger resumes this week", true],
    ["◆ General: Pay the water bill", false],
    ["2 status messages", null],
  ]);
});

test("rows of different heights scroll just enough to show the selected one", () => {
  const heights = [40, 20, 60, 20, 20];
  assert.deepEqual(rowWindow(heights, 0, 100), { first: 0, count: 2 });
  assert.deepEqual(rowWindow(heights, 2, 100, 0), { first: 1, count: 3 }, "a tall selected row pushes the top off");
  assert.deepEqual(rowWindow(heights, 1, 100, 1), { first: 1, count: 3 }, "scrolling back up keeps the view where it can");
  assert.deepEqual(rowWindow([150, 20], 0, 100), { first: 0, count: 1 }, "too tall still shows, clipped");
  assert.deepEqual(rowWindow([], 0, 100), { first: 0, count: 0 });
});

test("every entry offers Back first, then Dismiss and the categories it isn't", () => {
  assert.deepEqual(entryOptions("urgent").map((o) => o.label), ["Back", "Urgent – Dismiss", "Not urgent – TODO", "Not urgent – Status"]);
  assert.deepEqual(entryOptions("todo").map((o) => [o.action, o.to]), [["keep", undefined], ["dismiss", undefined], ["move", "urgent"], ["move", "status"]]);
  assert.deepEqual(entryOptions("status").map((o) => o.label), ["Back", "Status – Dismiss", "Not status – TODO", "Not status – Urgent"]);
  assert.deepEqual(entryOptions(null).map((o) => o.to ?? o.action), ["keep", "dismiss", "urgent", "todo", "status"]);
});

test("a notification's responses: buttons and canned replies, without repeats, and Android's suggestions until Claude's arrive", () => {
  const json = JSON.stringify([
    { title: "Mark as read", action: 0, reply: null },
    { title: "Reply", action: 1, reply: "On my way", canned: true },
    { title: "Reply", action: 1, reply: "On my way", canned: true },
    { title: "Reply", action: 1, reply: "  " },
    { title: "", action: 2, reply: null },
    { title: "Reply", action: 1, reply: null, freeForm: true },
    { title: "Reply", action: 1, reply: "Ok", suggested: true },
  ]);
  assert.deepEqual(parseResponses("k", json), {
    typed: true,
    responses: [
      { key: "k", index: 0, reply: null, label: "Mark as read" },
      { key: "k", index: 1, reply: "On my way", label: 'Reply: "On my way"' },
      { key: "k", index: 1, reply: "Ok", label: 'Reply: "Ok"' },
    ],
  });
  const withClaude = parseResponses("k", json, ["Yes, I'll get him", "Can't today", "What time?"]);
  assert.deepEqual(withClaude.responses.map((r) => r.label), ["Mark as read", 'Reply: "On my way"', `Reply: "Yes, I'll get him"`, `Reply: "Can't today"`, 'Reply: "What time?"']);
  assert.deepEqual(parseResponses("k", JSON.stringify([{ title: "Archive", action: 0, reply: null }])).typed, false);
  assert.deepEqual(parseResponses("k", "nope"), { responses: [], typed: false });
});

test("acting locally moves the entry and keeps what Claude first said", () => {
  const work = notebook("work", [entry("a", "urgent", "2026-09-30", "x")], [entry("b", "status", null, "y")]);
  let notebooks = applyLocally([work], "work", "a", { label: "", action: "move", to: "status" });
  assert.deepEqual([notebooks[0].entries.length, notebooks[0].statusCount, notebooks[0].status[0].firstCategory], [0, 2, "urgent"]);
  notebooks = applyLocally(notebooks, "work", "b", { label: "", action: "dismiss" });
  assert.equal(notebooks[0].statusCount, 1);
  assert.equal(applyLocally(notebooks, "work", "a", { label: "", action: "keep" }), notebooks);
  assert.equal(applyLocally(notebooks, "work", "a", { label: "", action: "respond" }), notebooks);
});

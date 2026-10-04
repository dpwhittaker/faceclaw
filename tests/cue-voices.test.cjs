const test = require("node:test");
const assert = require("node:assert/strict");

const { PRINT_WEIGHT_CAP, identify, normalize, pool, printKindFor, scoreCandidates, similarity, trainPrint } = require("../.test-build/app/apps/cue/voiceprints.js");
const { PcmRing, RunPools, RUN_FIRST_MS } = require("../.test-build/app/apps/cue/voice-pool.js");
const { httpBase, lineRanges, lineRuns, liveTranscript, nameLines, offsetOf } = require("../.test-build/app/apps/cue/after-conversation.js");

// Unit vectors along axes, a little noise toward a second axis.
const voice = (axis, noise = 0, other = (axis + 1) % 8) => normalize(Array.from({ length: 8 }, (_, i) => (i === axis ? 1 : i === other ? noise : 0)));

test("prints score by their better kind and train the closer one", () => {
  let priya = trainPrint(undefined, voice(0), "room");
  assert.equal(priya.room.count, 1);
  // On a call she sounds different enough to need a call print...
  priya = trainPrint(priya, voice(1, 0.2), "call");
  assert.ok(priya.call && priya.room);
  // ...and a later call sample that sounds like the room print trains the room one.
  priya = trainPrint(priya, voice(0, 0.1), "call");
  assert.equal(priya.room.count, 2);
  assert.equal(priya.call.count, 1);
  const store = { priya, tom: trainPrint(undefined, voice(3), "room") };
  const scores = scoreCandidates(voice(1, 0.2), store, ["tom", "priya", "nobody"]);
  assert.deepEqual(scores.map((s) => s.personId), ["priya", "tom"]);
  assert.ok(scores[0].similarity > 0.99);
});

test("training is a capped running mean, renormalized", () => {
  let prints;
  for (let i = 0; i < 40; i++) prints = trainPrint(prints, voice(0), "room");
  prints = trainPrint(prints, voice(1), "room");
  const moved = similarity(prints.room.embedding, voice(1));
  assert.ok(moved > 0.03 && moved < 0.06, `a late sample weighs about 1/${PRINT_WEIGHT_CAP + 1}: ${moved}`);
  assert.ok(Math.abs(similarity(prints.room.embedding, prints.room.embedding) - 1) < 1e-9);
  assert.equal(printKindFor("Microsoft Teams Meeting"), "call");
  assert.equal(printKindFor("Room 4B"), "room");
});

const pcm = (ms, value = 1) => new Uint8Array(ms * 32).fill(value);

test("the ring returns exactly the audio between two times, on the stream's clock", () => {
  const ring = new PcmRing(10_000);
  // Chunk n (1-based) is filled with n and arrives at 1000 + 50n.
  ring.anchor(1050);
  for (let t = 50; t <= 2000; t += 50) ring.push(pcm(50, t / 50), 1000 + t);
  const audio = ring.slice(1150, 1275);
  assert.equal(audio.length, 125 * 32);
  assert.equal(audio[0], 3, "the stream starts at chunk 1's arrival: 1150 is chunk 3's start");
  assert.equal(audio[audio.length - 1], 5);
  // Late, bunched arrivals don't move the clock: audio counts, as for Soniox.
  ring.push(pcm(50, 41), 2900);
  ring.push(pcm(50, 42), 2901);
  assert.equal(ring.slice(3050, 3100)[0], 41);
  assert.equal(ring.slice(3100, 3150)[0], 42);
  // A new stream after a reconnect starts at the first chunk it was sent, already in the ring.
  ring.anchor(2901);
  assert.equal(ring.slice(2901, 2951)[0], 42);
  assert.equal(ring.push(pcm(50, 43), 2960), 2951, "and later chunks follow it");
  ring.anchor(20_000);
  ring.push(pcm(50), 20_000);
  assert.equal(ring.slice(1000, 3000).length, 0, "old audio is dropped");
});

test("identify names someone only with a clear lead: high, medium, or a low guess", () => {
  assert.equal(identify([{ personId: "delisa", similarity: 0.62 }, { personId: "makayla", similarity: 0.48 }]).confidence, "high");
  assert.equal(identify([{ personId: "delisa", similarity: 0.47 }, { personId: "makayla", similarity: 0.41 }]).confidence, "medium");
  assert.equal(identify([{ personId: "delisa", similarity: 0.6 }, { personId: "makayla", similarity: 0.58 }]).confidence, "low", "too close to call");
  assert.equal(identify([{ personId: "you", similarity: 0.4 }]).confidence, "low");
  assert.equal(identify([]), null);
  assert.ok(Math.abs(similarity(pool([voice(0), voice(0, 0.2)]), voice(0, 0.1)) - 1) < 0.01);
});

test("a run is voice-printed at 8 s, then every 8 more while it goes on, and once more when it ends", () => {
  const ring = new PcmRing();
  for (let t = 50; t <= 120_000; t += 50) ring.push(pcm(50), t);
  const runs = new RunPools();
  const due = [];
  // Twelve 2 s segments (1.7 s of audio each once trimmed).
  for (let start = 1_000; start < 25_000; start += 2_000) due.push(...runs.add("Voice 1", ring, start, start + 2_000));
  assert.deepEqual(due.map((d) => Math.round(d.seconds)), [9, 17], "steps while the run goes on");
  // Another voice ends the run: printed again, with what it said since.
  const next = runs.add("Voice 2", ring, 26_000, 29_000);
  assert.equal(next.length, 1);
  assert.deepEqual([next[0].run.label, next[0].run.startMs, next[0].run.endMs, Math.round(next[0].seconds)], ["Voice 1", 1_000, 25_000, 20]);
  assert.equal(RUN_FIRST_MS, 8_000);
});

test("short runs are skipped and a pause splits one voice into runs", () => {
  const ring = new PcmRing();
  for (let t = 50; t <= 120_000; t += 50) ring.push(pcm(50), t);
  const runs = new RunPools();
  assert.deepEqual(runs.add("Voice 1", ring, 1_000, 1_900), []);
  assert.deepEqual(runs.add("Voice 2", ring, 2_000, 4_000).map((d) => d.run.label), [], "Voice 1 said under 1.5 s");
  const split = runs.add("Voice 2", ring, 30_000, 32_000);
  assert.deepEqual(split.map((d) => [d.run.label, d.run.startMs]), [["Voice 2", 2_000]], "the 26 s pause ended Voice 2's first run");
  assert.equal(runs.close().run.startMs, 30_000);
  assert.equal(runs.close(), null);
});

const parts = [{ startMs: 1_000_000, offsetMs: 0, durationMs: 60_000 }, { startMs: 2_000_000, offsetMs: 60_000, durationMs: 60_000 }];
const line = (label, text, start, end) => ({ label, text, startMs: start, endMs: end });

test("live lines map into a paused recording and group into runs", () => {
  assert.equal(offsetOf(parts, 2_001_000), 61_000);
  assert.equal(offsetOf(parts, 1_500_000), null, "between parts: not recorded");
  const lines = [
    line("Voice 1", "Hi.", 1_001_000, 1_002_000),
    line("Voice 1", "How's it going?", 1_002_500, 1_004_000),
    line("Voice 2", "Good.", 1_004_500, 1_005_000),
    line("Voice 1", "Great.", 1_040_000, 1_041_000),
    line("", "(no label)", 1_050_000, 1_050_000),
  ];
  assert.deepEqual(lineRuns(lines).map((r) => r.lines), [[0, 1], [2], [3], [4]], "a 35 s pause starts a new run");
  assert.deepEqual(lineRanges(lines, parts).slice(0, 2), [{ startMs: 1_000, endMs: 2_000 }, { startMs: 2_500, endMs: 4_000 }]);
  assert.equal(lineRanges(lines, parts)[4], null);
});

test("naming: a confident voice-print beats the live name; an unsure one leaves it", () => {
  const store = { delisa: trainPrint(undefined, voice(0), "room"), makayla: trainPrint(undefined, voice(3), "room"), you: trainPrint(undefined, voice(6), "room") };
  const names = new Map([["delisa", "DeLisa"], ["makayla", "Makayla"], ["you", "You"]]);
  // The wearer confirmed Voice 5 as Makayla, but this run sounds like DeLisa.
  const voices = [{ label: "Voice 5", personId: "makayla", name: "Makayla", confidence: "high", confirmed: true }, { label: "Voice 6", personId: "you", name: "You", confidence: "high", confirmed: true }];
  const lines = [line("Voice 5", "There's probably a road right here.", 0, 4_000), line("Voice 5", "It blocks off right there.", 4_100, 6_000), line("Voice 6", "Mm-hmm.", 6_500, 7_000), line("Voice 5", "Yeah.", 40_000, 40_500)];
  const named = nameLines(lines, [voice(0, 0.1), voice(0, 0.2), null, null], store, ["delisa", "makayla", "you"], names, voices);
  assert.deepEqual(named.map((s) => [s.name, s.confidence]), [["DeLisa", "high"], ["DeLisa", "high"], ["You", "medium"], ["Makayla", "medium"]]);
  // Too close to call: the live name stands, as a guess when nobody confirmed it.
  const unsure = nameLines([line("Voice 9", "Hello.", 0, 3_000)], [normalize([1, 0, 0, 0.98, 0, 0, 0, 0])], store, ["delisa", "makayla"], names, [{ label: "Voice 9", personId: "makayla", name: "Makayla", confidence: "medium", confirmed: false }]);
  assert.deepEqual([unsure[0].name, unsure[0].confidence], ["Makayla", "low"]);
  // A word or two isn't enough print to overrule the wearer's name for the voice.
  const short = nameLines([line("Voice 5", "Yeah.", 0, 600), line("Voice 5", "Okay.", 700, 1_400)], [voice(0), voice(0)], store, ["delisa", "makayla"], names, voices);
  assert.deepEqual(short.map((s) => [s.name, s.confidence]), [["Makayla", "medium"], ["Makayla", "medium"]]);
});

test("hand-off helpers: the live transcript as a fallback, the backend's HTTP address", () => {
  const lines = [line("Voice 1", "Hi.", 10, 20), line("Voice 2", "Hey.", 30, 40)];
  const voices = [{ label: "Voice 1", personId: "priya", name: "Priya", confidence: "medium", confirmed: true }];
  assert.deepEqual(liveTranscript(lines, voices).map((s) => [s.speaker, s.name, s.confidence]), [["Voice 1", "Priya", "medium"], ["Voice 2", null, "low"]]);
  assert.equal(httpBase("ws://100.1.2.3:8787/cue"), "http://100.1.2.3:8787");
  assert.equal(httpBase("wss://host.example"), "https://host.example");
  assert.equal(httpBase("nonsense"), "");
});

const test = require("node:test");
const assert = require("node:assert/strict");

const { PRINT_WEIGHT_CAP, normalize, printKindFor, scoreCandidates, similarity, trainPrint } = require("../.test-build/app/apps/cue/voiceprints.js");
const { PcmRing, VoicePools, POOL_FIRST_MS } = require("../.test-build/app/apps/cue/voice-pool.js");
const { multipartBody, nameSpeaker, sampleRanges, tokensToSegments, wallTime } = require("../.test-build/app/apps/cue/after-conversation.js");

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

test("a voice's pool asks to be embedded at 8 seconds, then every 8 more, up to 30", () => {
  const ring = new PcmRing();
  for (let t = 50; t <= 60_000; t += 50) ring.push(pcm(50), t);
  const pools = new VoicePools();
  const due = [];
  for (let start = 0; start < 50_000; start += 2_000) {
    const result = pools.add("Voice 1", ring, start, start + 2_000);
    if (result) due.push(Math.round(result.seconds));
  }
  assert.deepEqual(due, [9, 17, 26]);
  assert.equal(pools.add("Voice 2", ring, 0, 400), null, "too short to trust");
  assert.ok(pools.pooled("Voice 1").seconds <= 30);
  assert.equal(POOL_FIRST_MS, 8000);
});

const parts = [{ startMs: 1_000_000, offsetMs: 0, durationMs: 60_000 }, { startMs: 2_000_000, offsetMs: 60_000, durationMs: 60_000 }];

test("async tokens become speaker runs with wall-clock times across a paused recording", () => {
  assert.equal(wallTime(parts, 61_000), 2_001_000);
  const segments = tokensToSegments([
    { text: "Hi", start_ms: 1000, end_ms: 1400, speaker: 1 },
    { text: " there.", start_ms: 1400, end_ms: 1900, speaker: 1 },
    { text: " Hello.", start_ms: 62_000, end_ms: 62_600, speaker: 2 },
  ], parts);
  assert.deepEqual(segments.map((s) => [s.speaker, s.text, s.startMs, s.endMs]), [["1", "Hi there.", 1_001_000, 1_001_900], ["2", "Hello.", 2_002_000, 2_002_600]]);
});

test("samples come from long turns spread across the conversation", () => {
  const segments = Array.from({ length: 12 }, (_, i) => ({ speaker: "1", text: "", offsetStartMs: i * 20_000, offsetEndMs: i * 20_000 + (i % 3 === 0 ? 12_000 : 3_000), startMs: 0, endMs: 0 }));
  segments.push({ speaker: "1", text: "", offsetStartMs: 300_000, offsetEndMs: 301_000, startMs: 0, endMs: 0 });
  const ranges = sampleRanges(segments, "1", 4);
  assert.equal(ranges.length, 4);
  assert.ok(ranges.every((r) => r.endMs - r.startMs <= 8_000 && r.endMs - r.startMs >= 2_000));
  assert.ok(ranges[3].startMs > ranges[0].startMs + 100_000, "spread out");
});

function seg(speaker, startMs, endMs) {
  return { speaker, text: "x", offsetStartMs: startMs, offsetEndMs: endMs, startMs, endMs };
}

test("naming: a confirmed live name the prints agree with is high; prints alone need agreement", () => {
  const store = { priya: trainPrint(undefined, voice(0), "room"), tom: trainPrint(undefined, voice(3), "room") };
  const names = new Map([["priya", "Priya"], ["tom", "Tom"]]);
  const segments = [seg("1", 0, 10_000), seg("2", 10_000, 20_000)];
  const live = [{ startMs: 0, endMs: 9_000, personId: "priya", name: "Priya", confirmed: true }];
  assert.deepEqual(nameSpeaker(segments, "1", [voice(0, 0.1), voice(0, 0.2)], store, ["priya", "tom"], live, names), { personId: "priya", name: "Priya", confidence: "high" });
  // No live name for speaker 2; prints agree strongly.
  assert.deepEqual(nameSpeaker(segments, "2", [voice(3, 0.1), voice(3, 0.2), voice(3)], store, ["priya", "tom"], live, names), { personId: "tom", name: "Tom", confidence: "high" });
  // Prints that disagree with the live name make it low.
  assert.equal(nameSpeaker(segments, "1", [voice(3), voice(3, 0.1)], store, ["priya", "tom"], live, names).confidence, "low");
  // Nothing to go on.
  assert.deepEqual(nameSpeaker(segments, "2", [voice(6)], store, ["priya", "tom"], [], names), { personId: null, name: null, confidence: "low" });
});

test("multipart body wraps the file in one form field", () => {
  const body = multipartBody("XYZ", "file", "a.m4a", "audio/mp4", new Uint8Array([1, 2, 3]));
  const text = Buffer.from(body).toString("latin1");
  assert.match(text, /^--XYZ\r\nContent-Disposition: form-data; name="file"; filename="a.m4a"\r\nContent-Type: audio\/mp4\r\n\r\n\x01\x02\x03\r\n--XYZ--\r\n$/);
});

test("hand-off helpers: live names by time, the live transcript as a fallback, the backend's HTTP address", () => {
  const { httpBase, liveNames, liveTranscript } = require("../.test-build/app/apps/cue/after-conversation.js");
  const lines = [{ label: "Voice 1", text: "Hi.", startMs: 10, endMs: 20 }, { label: "Voice 2", text: "Hey.", startMs: 30, endMs: 40 }];
  const voices = [{ label: "Voice 1", personId: "priya", name: "Priya", confidence: "medium", confirmed: true }];
  assert.deepEqual(liveNames(lines, voices), [{ startMs: 10, endMs: 20, personId: "priya", name: "Priya", confirmed: true }]);
  assert.deepEqual(liveTranscript(lines, voices).map((s) => [s.speaker, s.name, s.confidence]), [["Voice 1", "Priya", "high"], ["Voice 2", null, "low"]]);
  assert.equal(httpBase("ws://100.1.2.3:8787/cue"), "http://100.1.2.3:8787");
  assert.equal(httpBase("wss://host.example"), "https://host.example");
  assert.equal(httpBase("nonsense"), "");
});

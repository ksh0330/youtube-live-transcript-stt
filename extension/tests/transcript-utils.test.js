const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyTranscriptDelta,
  buildExport,
  cleanSegments,
  promoteProvisional,
  safeFilename
} = require("../transcript-utils.js");

function fixtureState() {
  return {
    sessionId: "session-1",
    lastSequence: 0,
    metadata: { title: "C언어: 32비트?", url: "https://youtube.com/watch?v=test" },
    startedAt: "2026-01-01T00:00:00.000Z",
    stoppedAt: null,
    segments: [
      { start: 1.0, end: 5.0, text: "고정 소수점입니다" },
      { start: 4.5, end: 8.0, text: "32비트 안에서 설명합니다" }
    ],
    provisional: []
  };
}

test("SRT and VTT exports have monotonic valid timestamps and Korean UTF-8 text", () => {
  const state = fixtureState();
  const cleaned = cleanSegments(state.segments);
  assert.equal(cleaned[1].start, 5.0);
  assert.ok(cleaned.every(item => item.start < item.end));

  const srt = buildExport(state, "srt").content;
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:05,000\n고정 소수점입니다/m);
  assert.match(srt, /00:00:05,000 --> 00:00:08,000/);

  const vtt = buildExport(state, "vtt").content;
  assert.ok(vtt.startsWith("WEBVTT\n\n"));
  assert.match(vtt, /00:00:01\.000 --> 00:00:05\.000/);
});

test("TXT and JSON exports retain final segments and omit provisional text", () => {
  const state = fixtureState();
  state.provisional = [{ start: 8, end: 10, text: "아직 임시" }];
  assert.doesNotMatch(buildExport(state, "txt").content, /아직 임시/);
  const json = JSON.parse(buildExport(state, "json").content);
  assert.equal(json.segments.length, 2);
  assert.equal(json.segments[0].text, "고정 소수점입니다");
});

test("filename sanitization handles Windows-invalid characters and reserved names", () => {
  assert.equal(safeFilename("C언어: 32비트?"), "C언어_ 32비트_");
  assert.equal(safeFilename("CON"), "_CON");
});

test("transcript deltas update one shared state and reject stale sequences", () => {
  const state = fixtureState();
  const accepted = applyTranscriptDelta(state, {
    sessionId: "session-1",
    sequence: 1,
    finalized: [{ start: 8, end: 9, text: "확정" }],
    provisional: [{ start: 9, end: 11, text: "임시", provisional: true }],
    metrics: { liveDelay: 2.3 },
    serverStatus: "connected",
    error: null
  });
  assert.equal(accepted, true);
  assert.equal(state.segments.at(-1).text, "확정");
  assert.equal(state.provisional[0].text, "임시");
  assert.equal(state.metrics.liveDelay, 2.3);
  assert.equal(applyTranscriptDelta(state, { sessionId: "session-1", sequence: 1 }), false);
  assert.equal(applyTranscriptDelta(state, { sessionId: "other", sequence: 2 }), false);
});

test("stop promotes the last provisional segment without timestamp reversal", () => {
  const state = fixtureState();
  state.provisional = [{ start: 7.5, end: 10, text: "마지막 문장", provisional: true }];
  const promoted = promoteProvisional(state);
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].start, 8.0);
  assert.ok(promoted[0].end > promoted[0].start);
  assert.deepEqual(state.provisional, []);
});

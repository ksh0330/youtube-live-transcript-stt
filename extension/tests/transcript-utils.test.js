const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyTranscriptDelta,
  buildExport,
  cleanSegments,
  currentSentence,
  overlayText,
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

test("current sentence joins the stable part and the changing tail", () => {
  const current = currentSentence([
    { start: 10, end: 12, text: "오늘은 고정 소수점", stable: true },
    { start: 12, end: 13.5, text: "수 체계를" }
  ]);
  assert.equal(current.text, "오늘은 고정 소수점 수 체계를");
  assert.equal(current.stableText, "오늘은 고정 소수점");
  assert.equal(current.unstableText, "수 체계를");
  assert.equal(current.start, 10);
  assert.equal(current.end, 13.5);
  assert.equal(currentSentence([]), null);
});

test("overlay shows the previous sentence above the current one when both fit", () => {
  const segments = [{ text: "첫 문장입니다." }, { text: "두 번째 문장입니다." }];
  assert.equal(
    overlayText(segments, [{ text: "세 번째", stable: true }]),
    "두 번째 문장입니다.\n세 번째"
  );
  assert.equal(overlayText(segments, []), "첫 문장입니다.\n두 번째 문장입니다.");
  const long = "가".repeat(65);
  assert.equal(overlayText(segments, [{ text: long }]), long);
});

test("stop promotes stable and changing parts as one sentence", () => {
  const state = fixtureState();
  state.provisional = [
    { id: "s-3-p0", start: 8.5, end: 9.5, text: "마지막", stable: true },
    { id: "s-3-p1", start: 9.5, end: 10.5, text: "문장입니다." }
  ];
  const promoted = promoteProvisional(state);
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].text, "마지막 문장입니다.");
  assert.equal(state.segments.at(-1).end, 10.5);
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

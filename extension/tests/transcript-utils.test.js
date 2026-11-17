const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyTranscriptDelta,
  buildExport,
  cleanSegments,
  currentSentence,
  overlayText,
  promoteProvisional,
  safeFilename,
  wrapCaption
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

test("captions wrap into short, balanced lines at word boundaries", () => {
  assert.deepEqual(
    wrapCaption("가방에서 수익금을 인출하기 위한 용도의 대포 체크카드들이 무더기로 나옵니다.", 20),
    ["가방에서 수익금을 인출하기", "위한 용도의 대포 체크카드들이", "무더기로 나옵니다."]
  );
  // No one-word orphan at the end of a sentence.
  assert.deepEqual(
    wrapCaption("다치거나 숨지더라도 형사 책임을 묻지 않는데요.", 20),
    ["다치거나 숨지더라도 형사", "책임을 묻지 않는데요."]
  );
  assert.ok(wrapCaption("가".repeat(45), 20).every(line => line.length <= 20));
});

test("overlay rolls up like CC and shows only the newest two short lines", () => {
  const segments = [
    { text: "첫 문장입니다." },
    { text: "다치거나 숨지더라도 형사 책임을 묻지 않는데요." }
  ];
  // Last line of the previous sentence, then the sentence being spoken.
  assert.equal(
    overlayText(segments, [{ text: "이는 일정 요건을 충족", stable: true }], { lineChars: 20 }),
    "책임을 묻지 않는데요.\n이는 일정 요건을 충족"
  );
  // A long current sentence keeps only its newest two lines.
  const text = overlayText([], [{ text: "가방에서 수익금을 인출하기 위한 용도의 대포 체크카드들이 무더기로 나옵니다." }], { lineChars: 20 });
  assert.equal(text, "위한 용도의 대포 체크카드들이\n무더기로 나옵니다.");
  assert.ok(text.split("\n").every(line => line.length <= 20));
  // With nothing being spoken, the last sentence stays on screen.
  assert.equal(overlayText(segments, [], { lineChars: 20 }), "다치거나 숨지더라도 형사\n책임을 묻지 않는데요.");
});

test("SRT splits long sentences into cues of at most two short lines", () => {
  const state = fixtureState();
  state.segments = [{
    start: 0,
    end: 6,
    text: "이를 접한 네티즌들은 피해자를 보호하는 게 맞다, 국내 도입이 절실하다며 긍정적인 반응을 보였습니다."
  }];
  const srt = buildExport(state, "srt").content;
  const cues = srt.trim().split(/\n\n/);
  assert.equal(cues.length, 2);
  assert.ok(cues.every(cue => cue.split("\n").slice(2).every(line => line.length <= 26)));
  assert.ok(cues.every(cue => cue.split("\n").slice(2).length <= 2));
  assert.match(cues[1], /00:00:06,000/);
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

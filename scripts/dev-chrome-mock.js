(() => {
  "use strict";
  const segments = Array.from({ length: 520 }, (_, index) => ({
    id: `mock-${index}`,
    start: 125 + index * 4,
    end: 128.8 + index * 4,
    text: index === 519
      ? "고정 소수점에서는 정수부와 소수부를 함께 표현할 수 있습니다."
      : `기술 강의 전사 예시 ${index + 1}: x86과 x64 환경에서 int와 long 자료형을 비교합니다.`
  }));
  const mockState = {
    sessionId: "visual-qa",
    recording: true,
    tabId: 1,
    startedAt: "2026-08-25T05:00:00.000Z",
    stoppedAt: null,
    metadata: {
      title: "C 언어 고정 소수점과 자료형 — 실시간 기술 강의",
      url: "https://youtube.com/watch?v=visualqa",
      videoId: "visualqa",
      channel: "개발 강의 채널"
    },
    segments,
    provisional: [{
      id: "mock-provisional-stable",
      start: 2205,
      end: 2207,
      text: "다음 구간에서는 scaling factor와",
      provisional: true,
      stable: true
    }, {
      id: "mock-provisional",
      start: 2207,
      end: 2209,
      text: "Floating Point의 차이를 설명하겠습니다",
      provisional: true
    }],
    lastSequence: 521,
    metrics: { liveDelay: 2.3, inferenceSeconds: 1.8, queueSeconds: 0, droppedSeconds: 0 },
    overlayEnabled: true,
    settings: { overlayPosition: "bottom", overlaySize: "medium", overlayOpacity: 0.8, contextPrompt: "반도체 및 임베디드 C 강의입니다." },
    serverStatus: "connected",
    error: null
  };

  globalThis.chrome = {
    runtime: {
      id: "visual-qa",
      onMessage: { addListener() {} },
      async sendMessage(message) {
        if (message.type === "YTLT_GET_APP_STATE") return { ok: true, state: mockState };
        if (message.type === "YTLT_SET_OVERLAY") mockState.overlayEnabled = Boolean(message.enabled);
        if (message.type === "YTLT_SET_SETTINGS") mockState.settings = { ...mockState.settings, ...message.settings };
        if (message.type === "YTLT_STT_STOP") mockState.recording = false;
        return { ok: true, state: mockState };
      }
    },
    downloads: { async download() { return 1; } },
    sidePanel: { async open() {} }
  };
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        model_loaded: true,
        model_size: "small",
        device_resolved: "cpu",
        compute_type: "int8",
        chunk_seconds: 4,
        overlap_seconds: 2
      };
    }
  });
})();

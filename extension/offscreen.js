(() => {
  "use strict";

  let stream = null;
  let audioContext = null;
  let sourceNode = null;
  let processorNode = null;
  let silentGain = null;
  let socket = null;
  let running = false;
  let activeSessionId = null;
  let stopAckResolver = null;
  let inputRate = 48000;
  const TARGET_RATE = 16000;

  async function reportStatus(status, error = null, sessionId = activeSessionId) {
    try {
      await chrome.runtime.sendMessage({
        type: "YTLT_OFFSCREEN_STATUS",
        target: "background",
        status,
        error,
        sessionId
      });
    } catch (_) {}
  }

  async function reportError(error, sessionId = activeSessionId) {
    const message = String(error?.message || error || "Unknown STT error");
    try {
      await chrome.runtime.sendMessage({
        type: "YTLT_OFFSCREEN_ERROR",
        target: "background",
        error: message,
        sessionId
      });
    } catch (_) {}
  }

  function downsampleTo16k(input, sourceRate) {
    if (!input?.length) return new Int16Array(0);

    if (sourceRate === TARGET_RATE) {
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    }

    const ratio = sourceRate / TARGET_RATE;
    const outputLength = Math.max(1, Math.floor(input.length / ratio));
    const out = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j++) {
        sum += input[j];
        count += 1;
      }
      const sample = Math.max(-1, Math.min(1, count ? sum / count : input[start] || 0));
      out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return out;
  }

  async function requestServerFlush() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        stopAckResolver = null;
        resolve();
      };
      stopAckResolver = finish;
      try {
        socket.send(JSON.stringify({ type: "stop" }));
      } catch (_) {
        finish();
        return;
      }
      setTimeout(finish, 6000);
    });
  }

  async function stopCapture({ flush = true } = {}) {
    const stoppedSessionId = activeSessionId;
    running = false;

    if (flush) {
      await requestServerFlush();
    }

    if (processorNode) {
      processorNode.onaudioprocess = null;
      try { processorNode.disconnect(); } catch (_) {}
      processorNode = null;
    }
    if (silentGain) {
      try { silentGain.disconnect(); } catch (_) {}
      silentGain = null;
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch (_) {}
      sourceNode = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch (_) {}
      }
      stream = null;
    }
    if (audioContext) {
      try { await audioContext.close(); } catch (_) {}
      audioContext = null;
    }
    if (socket) {
      try { socket.close(1000, "capture stopped"); } catch (_) {}
      socket = null;
    }

    if (stoppedSessionId !== null) {
      await reportStatus("stopped", null, stoppedSessionId);
    }
    if (activeSessionId === stoppedSessionId) activeSessionId = null;
  }

  function connectWebSocket(wsUrl, language, initialPrompt, sessionId) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";

      const timeout = setTimeout(() => {
        try { ws.close(); } catch (_) {}
        reject(new Error("로컬 STT 서버 연결 시간이 초과되었습니다. local-stt-server를 먼저 실행하세요."));
      }, 5000);

      ws.onopen = () => {
        clearTimeout(timeout);
        socket = ws;
        ws.send(JSON.stringify({
          type: "config",
          language: language || "ko",
          initial_prompt: String(initialPrompt || "").slice(0, 1000)
        }));
        reportStatus("connected", null, sessionId);
        resolve(ws);
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("로컬 STT 서버(ws://127.0.0.1:8765)에 연결할 수 없습니다."));
      };

      ws.onclose = (event) => {
        if (running && event.code !== 1000) {
          reportStatus("disconnected", `STT 서버 연결 종료: ${event.code}`, sessionId);
          // Release MediaStream on abnormal STT server disconnect.
          setTimeout(() => {
            if (running) stopCapture({ flush: false }).catch(() => {});
          }, 0);
        }
      };

      ws.onmessage = async (event) => {
        if (typeof event.data !== "string") return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === "transcript_update") {
            await chrome.runtime.sendMessage({
              type: "YTLT_OFFSCREEN_TRANSCRIPT_UPDATE",
              target: "background",
              sessionId,
              sequence: data.sequence,
              finalized: Array.isArray(data.finalized) ? data.finalized : [],
              provisional: Array.isArray(data.provisional) ? data.provisional : [],
              audio_end: data.audio_end,
              inference_ms: data.inference_ms,
              queue_seconds: data.queue_seconds,
              dropped_seconds: data.dropped_seconds,
              new_seconds: data.new_seconds,
              window_seconds: data.window_seconds,
              mode: data.mode
            });
          } else if (data.type === "transcript" && data.text) {
            await chrome.runtime.sendMessage({
              type: "YTLT_OFFSCREEN_TRANSCRIPT",
              target: "background",
              sessionId,
              text: data.text,
              raw: data.raw || data.text,
              sequence: data.sequence,
              new_seconds: data.new_seconds,
              window_seconds: data.window_seconds
            });
          } else if (data.type === "status") {
            const status = data.status || "connected";
            await reportStatus(status, status === "error" ? data.message || null : null, sessionId);
          } else if (data.type === "error") {
            await reportError(data.message || "STT server error", sessionId);
            // A failed inference must not leave Chrome tabCapture alive.
            // Otherwise the next attempt fails with:
            // "Cannot capture a tab with an active stream."
            await stopCapture({ flush: false });
          } else if (data.type === "stop_ack") {
            stopAckResolver?.();
          }
        } catch (error) {
          await reportError(error, sessionId);
        }
      };
    });
  }

  async function startCapture({ streamId, wsUrl, language, initialPrompt, sessionId }) {
    await stopCapture({ flush: false });
    activeSessionId = sessionId || `${Date.now()}`;
    const currentSessionId = activeSessionId;
    await reportStatus("connecting", null, currentSessionId);

    const ws = await connectWebSocket(wsUrl, language, initialPrompt, currentSessionId);

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId
          }
        },
        video: false
      });
    } catch (error) {
      try { ws.close(); } catch (_) {}
      socket = null;
      throw new Error(`YouTube 탭 오디오 캡처 실패: ${error?.message || error}`);
    }

    audioContext = new AudioContext();
    try { await audioContext.resume(); } catch (_) {}
    inputRate = audioContext.sampleRate || 48000;

    sourceNode = audioContext.createMediaStreamSource(stream);

    // tabCapture 사용 시 원래 탭 오디오가 사용자에게 재생되지 않으므로
    // 캡처한 오디오를 기본 출력 장치로 다시 연결한다.
    sourceNode.connect(audioContext.destination);

    // ScriptProcessor는 deprecated이지만 Chrome 116+에서 안정적으로 동작하며,
    // 이 로컬 MVP에서는 외부 Worklet 모듈 없이 PCM을 얻는 가장 단순한 경로다.
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    sourceNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    running = true;

    processorNode.onaudioprocess = (event) => {
      if (!running || !socket || socket.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm16 = downsampleTo16k(input, inputRate);
      if (pcm16.byteLength) {
        try {
          socket.send(pcm16.buffer);
        } catch (error) {
          reportError(error);
        }
      }
    };

    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (running) {
          reportError("탭 오디오 캡처가 종료되었습니다.", currentSessionId);
          stopCapture({ flush: false });
        }
      }, { once: true });
    }

    await reportStatus("capturing", null, currentSessionId);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "offscreen") return;

    if (message.type === "YTLT_OFFSCREEN_START") {
      startCapture(message)
        .then(() => sendResponse({ ok: true }))
        .catch(async (error) => {
          await reportError(error);
          await stopCapture({ flush: false });
          sendResponse({ ok: false, error: String(error?.message || error) });
        });
      return true;
    }

    if (message.type === "YTLT_OFFSCREEN_STOP") {
      stopCapture({ flush: true })
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }
  });
})();

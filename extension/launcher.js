(() => {
  "use strict";

  const els = {
    tabTitle: document.getElementById("tabTitle"),
    statusDot: document.getElementById("statusDot"),
    statusText: document.getElementById("statusText"),
    message: document.getElementById("message"),
    startBtn: document.getElementById("startBtn"),
    releaseBtn: document.getElementById("releaseBtn"),
    openPanelBtn: document.getElementById("openPanelBtn"),
    openWindowBtn: document.getElementById("openWindowBtn")
  };

  let activeTabId = null;
  let ready = false;

  function isYouTube(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname === "youtube.com" || parsed.hostname.endsWith(".youtube.com");
    } catch {
      return false;
    }
  }

  function setStatus(type, text) {
    els.statusDot.className = `dot ${type || ""}`.trim();
    els.statusText.textContent = text;
  }

  async function prepare() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !isYouTube(tab.url || "")) {
        throw new Error("YouTube 영상/라이브 탭에서 확장 프로그램을 눌러주세요.");
      }

      activeTabId = tab.id;
      els.tabTitle.textContent = tab.title || "YouTube";

      // Prepare offscreen document before the actual user-gesture capture call.
      const offscreen = await chrome.runtime.sendMessage({
        type: "YTLT_PREPARE_CAPTURE",
        target: "background"
      });
      if (!offscreen?.ok) {
        throw new Error(offscreen?.error || "오디오 처리 문서 준비 실패");
      }

      setStatus("", "Whisper 서버 확인 중…");
      let health = await fetch("http://127.0.0.1:8765/health", { cache: "no-store" });
      if (!health.ok) throw new Error(`로컬 STT 서버 HTTP ${health.status}`);
      let data = await health.json();

      if (!data.model_loaded) {
        setStatus("", `${data.model_size || "Whisper"} 모델 로드/다운로드 중…`);
        els.message.textContent = "첫 실행이면 모델 다운로드 때문에 시간이 걸릴 수 있습니다. 콘솔 창을 닫지 마세요.";

        const warmup = await fetch("http://127.0.0.1:8765/warmup", {
          method: "POST",
          cache: "no-store"
        });
        const warmupData = await warmup.json().catch(() => ({}));
        if (!warmup.ok) {
          throw new Error(warmupData.error || `Whisper 모델 준비 실패: HTTP ${warmup.status}`);
        }
        data = { ...data, ...warmupData };
      }

      ready = true;
      setStatus("ok", `준비됨 · ${data.model_size || "small"} · ${data.device_resolved || data.device || "auto"}`);
      els.message.textContent = "아래 버튼을 누르는 순간 현재 YouTube 탭에 대한 Chrome 캡처 권한을 얻고 STT를 시작합니다.";
      els.startBtn.disabled = false;
      els.startBtn.textContent = "현재 YouTube 탭 STT 시작";
      els.releaseBtn.disabled = false;
      els.releaseBtn.textContent = "남아 있는 캡처 강제 해제";
      els.releaseBtn.classList.add("hidden");
    } catch (error) {
      ready = false;
      setStatus("error", "시작할 수 없음");
      els.message.textContent = String(error?.message || error);
      els.startBtn.disabled = true;
      els.startBtn.textContent = "STT 시작 불가";
    }
  }

  els.startBtn.addEventListener("click", () => {
    if (!ready || !activeTabId) return;

    els.startBtn.disabled = true;
    els.startBtn.textContent = "캡처 권한 획득 중…";

    // IMPORTANT: do this immediately and synchronously in the popup click handler.
    // Awaiting anything before this call can lose the Chrome user gesture.
    const streamPromise = chrome.tabCapture.getMediaStreamId({
      targetTabId: activeTabId
    });

    // Also open the side panel directly from the same user gesture.
    const panelPromise = chrome.sidePanel.open({ tabId: activeTabId });

    Promise.all([streamPromise, panelPromise])
      .then(async ([streamId]) => {
        const response = await chrome.runtime.sendMessage({
          type: "YTLT_STT_START_WITH_STREAM",
          target: "background",
          streamId,
          tabId: activeTabId
        });

        if (!response?.ok) {
          throw new Error(response?.error || "STT 시작 실패");
        }

        setStatus("ok", "STT 캡처 시작됨");
        els.message.textContent = "Side Panel에서 실시간 자막을 확인하세요.";
        els.startBtn.textContent = "시작됨";
        setTimeout(() => window.close(), 700);
      })
      .catch((error) => {
        const message = String(error?.message || error);
        setStatus("error", "캡처 실패");
        els.message.textContent = message;
        els.startBtn.disabled = false;
        els.startBtn.textContent = "다시 시도";

        if (message.includes("active stream")) {
          els.releaseBtn.classList.remove("hidden");
        }
      });
  });

  els.releaseBtn.addEventListener("click", async () => {
    els.releaseBtn.disabled = true;
    els.releaseBtn.textContent = "해제 중…";
    try {
      const response = await chrome.runtime.sendMessage({
        type: "YTLT_FORCE_RELEASE_CAPTURE",
        target: "background"
      });
      if (!response?.ok) {
        throw new Error(response?.error || "캡처 해제 실패");
      }

      setStatus("ok", "기존 캡처 해제됨");
      els.message.textContent = "이제 ‘다시 시도’를 눌러 현재 YouTube 탭 STT를 시작하세요.";
      els.releaseBtn.classList.add("hidden");
    } catch (error) {
      setStatus("error", "캡처 해제 실패");
      els.message.textContent = String(error?.message || error);
      els.releaseBtn.disabled = false;
      els.releaseBtn.textContent = "남아 있는 캡처 강제 해제";
    }
  });

  els.openPanelBtn.addEventListener("click", () => {
    if (!activeTabId) return;
    chrome.sidePanel.open({ tabId: activeTabId })
      .then(() => window.close())
      .catch((error) => {
        els.message.textContent = String(error?.message || error);
      });
  });

  els.openWindowBtn.addEventListener("click", async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "YTLT_OPEN_DETACHED",
        target: "background"
      });
      if (!response?.ok) {
        throw new Error(response?.error || "독립 창을 열지 못했습니다.");
      }
      window.close();
    } catch (error) {
      els.message.textContent = String(error?.message || error);
    }
  });

  prepare();
})();

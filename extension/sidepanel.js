(() => {
  "use strict";

  const utils = globalThis.YTLTUtils;
  const MAX_DOM_ITEMS = 500;
  const els = {
    statusBadge: document.getElementById("statusBadge"),
    viewModeBtn: document.getElementById("viewModeBtn"),
    viewModeHint: document.getElementById("viewModeHint"),
    notice: document.getElementById("notice"),
    serverState: document.getElementById("serverState"),
    checkServerBtn: document.getElementById("checkServerBtn"),
    videoTitle: document.getElementById("videoTitle"),
    videoMeta: document.getElementById("videoMeta"),
    segmentCount: document.getElementById("segmentCount"),
    wordCount: document.getElementById("wordCount"),
    lastTime: document.getElementById("lastTime"),
    liveDelay: document.getElementById("liveDelay"),
    startBtn: document.getElementById("startBtn"),
    stopBtn: document.getElementById("stopBtn"),
    clearBtn: document.getElementById("clearBtn"),
    overlayToggle: document.getElementById("overlayToggle"),
    overlayPosition: document.getElementById("overlayPosition"),
    overlaySize: document.getElementById("overlaySize"),
    overlayOpacity: document.getElementById("overlayOpacity"),
    contextPrompt: document.getElementById("contextPrompt"),
    saveSettingsBtn: document.getElementById("saveSettingsBtn"),
    settingsStatus: document.getElementById("settingsStatus"),
    searchInput: document.getElementById("searchInput"),
    autoScrollToggle: document.getElementById("autoScrollToggle"),
    transcript: document.getElementById("transcript"),
    exportButtons: Array.from(document.querySelectorAll("[data-format]"))
  };

  let state = null;
  let serverOk = false;
  let renderSignature = "";
  let userScrolledUp = false;
  let settingsDirty = false;
  const isWindowMode = new URLSearchParams(location.search).get("mode") === "window";

  if (isWindowMode) {
    document.body.classList.add("window-mode");
    document.title = "YouTube Live Transcript STT — Window";
    els.viewModeBtn.textContent = "Side Panel 열기";
    els.viewModeHint.textContent = "독립 창 모드";
  } else {
    els.viewModeBtn.textContent = "새 창으로 분리";
    els.viewModeHint.textContent = "Side Panel 모드";
  }

  function showNotice(message, kind = "manual") {
    els.notice.textContent = message;
    els.notice.dataset.kind = kind;
    els.notice.classList.remove("hidden");
  }

  function hideNotice(kind = null) {
    if (kind && els.notice.dataset.kind !== kind) return;
    els.notice.textContent = "";
    els.notice.dataset.kind = "";
    els.notice.classList.add("hidden");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function highlight(text, query) {
    const safe = escapeHtml(text);
    const q = String(query || "").trim();
    if (!q) return safe;
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return safe.replace(new RegExp(`(${escaped})`, "gi"), "<mark>$1</mark>");
  }

  async function checkServer() {
    els.serverState.textContent = "확인 중…";
    try {
      const response = await fetch("http://127.0.0.1:8765/health", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let data = await response.json();
      const model = data.model_size || "Whisper";
      if (!data.model_loaded) {
        els.serverState.textContent = `${model} 모델 준비 중…`;
        showNotice("첫 실행이면 Whisper 모델 다운로드가 진행될 수 있습니다. 완료 후 STT를 시작할 수 있습니다.", "server");
        const warm = await fetch("http://127.0.0.1:8765/warmup", { method: "POST", cache: "no-store" });
        const warmData = await warm.json().catch(() => ({}));
        if (!warm.ok) throw new Error(warmData.error || `모델 준비 실패: HTTP ${warm.status}`);
        data = { ...data, ...warmData, model_loaded: true };
      }
      serverOk = Boolean(data.model_loaded);
      const device = data.device_resolved || data.device || "auto";
      const compute = data.compute_type || "";
      const rolling = data.chunk_seconds ? ` · ${data.chunk_seconds}+${data.overlap_seconds || 0}s` : "";
      els.serverState.textContent = `정상 · ${model} · ${device}${compute ? ` · ${compute}` : ""}${rolling}`;
      hideNotice("server");
    } catch (error) {
      serverOk = false;
      const message = String(error?.message || error);
      const serverMissing = message.includes("Failed to fetch");
      els.serverState.textContent = serverMissing ? "연결 안 됨" : "준비 실패";
      showNotice(
        serverMissing
          ? "로컬 STT 서버가 실행되지 않았습니다. local-stt-server/start_server.bat를 먼저 실행하세요."
          : message,
        "server"
      );
    }
    render();
  }

  async function refreshState() {
    const response = await chrome.runtime.sendMessage({ type: "YTLT_GET_APP_STATE", target: "background" });
    if (response?.ok) {
      state = response.state;
      renderSignature = "";
      render();
    }
  }

  function renderTranscript() {
    const finalItems = state?.segments || [];
    const provisionalItems = state?.provisional || [];
    const query = els.searchInput.value.trim().toLowerCase();
    const matchingFinal = query
      ? finalItems.filter(item => String(item.text || "").toLowerCase().includes(query))
      : finalItems;
    const matchingProvisional = provisionalItems.filter(item =>
      !query || String(item.text || "").toLowerCase().includes(query)
    );
    const visibleFinal = matchingFinal.slice(-MAX_DOM_ITEMS);
    const signature = [
      state?.sessionId,
      finalItems.length,
      finalItems.at(-1)?.id,
      matchingProvisional.map(item => item.text).join("|"),
      query,
      visibleFinal.length
    ].join(":");
    if (signature === renderSignature) return;

    if (!visibleFinal.length && !matchingProvisional.length) {
      els.transcript.innerHTML = `<p class="empty">${query ? "검색 결과가 없습니다." : "STT를 시작하면 약 4초마다 rolling 전사 결과가 쌓입니다."}</p>`;
      renderSignature = signature;
      return;
    }

    const limitNote = matchingFinal.length > MAX_DOM_ITEMS
      ? `<p class="render-limit">화면 성능을 위해 최근 ${MAX_DOM_ITEMS}개만 표시합니다. 검색과 내보내기는 전체 기록을 사용합니다.</p>`
      : "";
    const finalHtml = visibleFinal.map(item => `
      <article class="transcript-item">
        <time class="transcript-time">${utils.formatClock(item.start)}</time>
        <div class="transcript-text">${highlight(item.text, els.searchInput.value)}</div>
      </article>
    `).join("");
    const provisionalHtml = matchingProvisional.map(item => `
      <article class="transcript-item provisional">
        <time class="transcript-time">${utils.formatClock(item.start)}</time>
        <div class="transcript-text"><span class="provisional-label">임시 · 다음 결과에서 수정될 수 있음</span>${highlight(item.text, els.searchInput.value)}</div>
      </article>
    `).join("");
    els.transcript.innerHTML = `${limitNote}${finalHtml}${provisionalHtml}`;

    if (els.autoScrollToggle.checked && !query && !userScrolledUp) {
      els.transcript.scrollTop = els.transcript.scrollHeight;
    }
    renderSignature = signature;
  }

  function renderSettings() {
    if (settingsDirty) return;
    const settings = state?.settings || {};
    els.overlayPosition.value = settings.overlayPosition || "bottom";
    els.overlaySize.value = settings.overlaySize || "medium";
    els.overlayOpacity.value = String(settings.overlayOpacity ?? 0.8);
    els.contextPrompt.value = settings.contextPrompt || "";
  }

  function render() {
    const items = state?.segments || [];
    const provisional = state?.provisional || [];
    const recording = Boolean(state?.recording);
    const status = state?.serverStatus || "unknown";

    if (recording) {
      els.statusBadge.textContent = ["capturing", "connected", "ready"].includes(status) ? "STT 기록 중" : "연결 중";
      els.statusBadge.className = "badge live";
    } else if (items.length) {
      els.statusBadge.textContent = "중지됨";
      els.statusBadge.className = "badge idle";
    } else {
      els.statusBadge.textContent = serverOk ? "준비" : "대기";
      els.statusBadge.className = serverOk ? "badge ready" : "badge idle";
    }

    els.videoTitle.textContent = state?.metadata?.title || "YouTube 라이브를 열어주세요.";
    const channel = state?.metadata?.channel ? ` · ${state.metadata.channel}` : "";
    els.videoMeta.textContent = state?.metadata ? `${state.metadata.videoId || "YouTube"}${channel}` : "CC가 없어도 탭 오디오로 인식합니다.";
    const allText = [...items, ...provisional].map(item => item.text).join(" ").trim();
    els.segmentCount.textContent = String(items.length);
    els.wordCount.textContent = allText ? String(allText.split(/\s+/).filter(Boolean).length) : "0";
    els.lastTime.textContent = utils.formatClock(items.at(-1)?.end || provisional.at(-1)?.end || 0);
    const delay = Number(state?.metrics?.liveDelay);
    els.liveDelay.textContent = Number.isFinite(delay) ? `${delay.toFixed(1)}s` : "—";
    els.overlayToggle.checked = Boolean(state?.overlayEnabled);

    els.startBtn.disabled = recording;
    els.stopBtn.disabled = !recording;
    els.clearBtn.disabled = !recording && !items.length && !provisional.length;
    els.exportButtons.forEach(button => button.disabled = !items.length);
    if (state?.error) showNotice(state.error, "state");
    else hideNotice("state");
    if (!state?.error && Number(state?.metrics?.droppedSeconds) > 0) {
      showNotice(`실시간 위치를 유지하기 위해 누적 ${Number(state.metrics.droppedSeconds).toFixed(1)}초의 오래된 대기 오디오를 건너뛰었습니다.`, "overload");
    } else {
      hideNotice("overload");
    }
    renderSettings();
    renderTranscript();
  }

  async function download(format) {
    const file = utils.buildExport(state, format);
    const blob = new Blob([file.content], { type: file.mime });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);
    try {
      await chrome.downloads.download({
        url,
        filename: `${utils.safeFilename(state?.metadata?.title)}_${date}.${file.ext}`,
        saveAs: true
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  }

  els.viewModeBtn.addEventListener("click", async () => {
    try {
      if (!isWindowMode) {
        const response = await chrome.runtime.sendMessage({ type: "YTLT_OPEN_DETACHED", target: "background" });
        if (!response?.ok) throw new Error(response?.error || "독립 창을 열지 못했습니다.");
        return;
      }
      if (!state?.tabId) {
        showNotice("아직 연결된 YouTube 탭이 없습니다. YouTube 탭에서 툴바의 YT Live STT 아이콘을 먼저 실행하세요.");
        return;
      }
      await chrome.sidePanel.open({ tabId: state.tabId });
    } catch (error) {
      showNotice(String(error?.message || error));
    }
  });

  els.checkServerBtn.addEventListener("click", checkServer);
  els.startBtn.addEventListener("click", () => {
    showNotice("새 STT 시작은 Chrome 툴바의 YT Live STT 아이콘에서 실행하세요.");
  });
  els.stopBtn.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({ type: "YTLT_STT_STOP", target: "background" });
    if (response?.ok) state = response.state;
    renderSignature = "";
    render();
  });
  els.clearBtn.addEventListener("click", async () => {
    if (!confirm("현재 저장된 전사 기록을 모두 지울까요?")) return;
    const response = await chrome.runtime.sendMessage({ type: "YTLT_CLEAR", target: "background" });
    if (response?.ok) state = response.state;
    renderSignature = "";
    render();
  });
  els.overlayToggle.addEventListener("change", async () => {
    const response = await chrome.runtime.sendMessage({
      type: "YTLT_SET_OVERLAY",
      target: "background",
      enabled: els.overlayToggle.checked
    });
    if (response?.ok) state = response.state;
    render();
  });

  [els.overlayPosition, els.overlaySize, els.overlayOpacity, els.contextPrompt].forEach(input => {
    input.addEventListener("input", () => {
      settingsDirty = true;
      els.settingsStatus.textContent = "저장되지 않은 변경 사항이 있습니다.";
    });
  });
  els.saveSettingsBtn.addEventListener("click", async () => {
    els.saveSettingsBtn.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "YTLT_SET_SETTINGS",
        target: "background",
        settings: {
          overlayPosition: els.overlayPosition.value,
          overlaySize: els.overlaySize.value,
          overlayOpacity: Number(els.overlayOpacity.value),
          contextPrompt: els.contextPrompt.value
        }
      });
      if (!response?.ok) throw new Error(response?.error || "설정을 저장하지 못했습니다.");
      state = response.state;
      settingsDirty = false;
      els.settingsStatus.textContent = "저장됨 · 문맥 프롬프트는 다음 STT 시작부터 적용됩니다.";
      render();
    } catch (error) {
      showNotice(String(error?.message || error));
    } finally {
      els.saveSettingsBtn.disabled = false;
    }
  });

  els.searchInput.addEventListener("input", () => {
    renderSignature = "";
    renderTranscript();
  });
  els.autoScrollToggle.addEventListener("change", () => {
    if (els.autoScrollToggle.checked) userScrolledUp = false;
    renderSignature = "";
    renderTranscript();
  });
  els.transcript.addEventListener("scroll", () => {
    const distance = els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight;
    userScrolledUp = distance > 80;
  }, { passive: true });
  els.exportButtons.forEach(button => button.addEventListener("click", () => download(button.dataset.format)));

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "YTLT_STATE" && message?.target === "ui") {
      state = message.state;
      renderSignature = "";
      render();
    } else if (message?.type === "YTLT_TRANSCRIPT_DELTA" && message?.target === "ui") {
      if (utils.applyTranscriptDelta(state, message.delta)) render();
    }
  });

  Promise.all([refreshState(), checkServer()]).catch(console.error);
})();

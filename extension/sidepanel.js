(() => {
  "use strict";

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
    startBtn: document.getElementById("startBtn"),
    stopBtn: document.getElementById("stopBtn"),
    clearBtn: document.getElementById("clearBtn"),
    overlayToggle: document.getElementById("overlayToggle"),
    searchInput: document.getElementById("searchInput"),
    autoScrollToggle: document.getElementById("autoScrollToggle"),
    transcript: document.getElementById("transcript"),
    exportButtons: Array.from(document.querySelectorAll("[data-format]"))
  };

  let state = null;
  let serverOk = false;
  let lastRenderedCount = 0;
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

  function showNotice(message) {
    els.notice.textContent = message;
    els.notice.classList.remove("hidden");
  }
  function hideNotice() {
    els.notice.textContent = "";
    els.notice.classList.add("hidden");
  }

  function formatClock(seconds) {
    const whole = Math.floor(Math.max(0, Number(seconds) || 0));
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    return [h,m,s].map(v => String(v).padStart(2,"0")).join(":");
  }
  function srtTime(seconds) {
    const ms = Math.max(0, Math.round((Number(seconds)||0)*1000));
    const h = Math.floor(ms/3600000);
    const m = Math.floor((ms%3600000)/60000);
    const s = Math.floor((ms%60000)/1000);
    const x = ms%1000;
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(x).padStart(3,"0")}`;
  }
  function escapeHtml(value) {
    return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
  }
  function highlight(text, query) {
    const safe = escapeHtml(text);
    const q = String(query||"").trim();
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
        showNotice("첫 실행이면 Whisper 모델 다운로드가 진행될 수 있습니다. 완료되면 STT 시작 버튼을 사용할 수 있습니다.");
        const warm = await fetch("http://127.0.0.1:8765/warmup", {
          method: "POST",
          cache: "no-store"
        });
        if (!warm.ok) throw new Error(`모델 준비 실패: HTTP ${warm.status}`);
        const warmed = await warm.json();
        data = { ...data, ...warmed, model_loaded: true };
      }

      serverOk = Boolean(data.model_loaded);
      const device = data.device_resolved || data.device || "auto";
      const compute = data.compute_type || "";
      els.serverState.textContent = `정상 · ${model} · ${device}${compute ? ` · ${compute}` : ""} · 모델 준비됨`;
      hideNotice();
    } catch (_) {
      serverOk = false;
      els.serverState.textContent = "연결 안 됨";
      showNotice("로컬 STT 서버가 실행되지 않았습니다. ZIP의 local-stt-server/start_server.bat를 먼저 실행하세요.");
    }
    render();
  }

  async function refreshState() {
    const response = await chrome.runtime.sendMessage({ type: "YTLT_GET_APP_STATE", target: "background" });
    if (response?.ok) {
      state = response.state;
      render();
    }
  }

  function renderTranscript() {
    const items = state?.segments || [];
    const q = els.searchInput.value.trim().toLowerCase();
    const filtered = q ? items.filter(x => String(x.text||"").toLowerCase().includes(q)) : items;

    if (!filtered.length) {
      els.transcript.innerHTML = `<p class="empty">${q ? "검색 결과가 없습니다." : "STT를 시작하면 약 5초 단위로 전사 결과가 쌓입니다."}</p>`;
      lastRenderedCount = 0;
      return;
    }

    els.transcript.innerHTML = filtered.map(item => `
      <article class="transcript-item">
        <time class="transcript-time">${formatClock(item.start)}</time>
        <div class="transcript-text">${highlight(item.text, els.searchInput.value)}</div>
      </article>
    `).join("");

    if (els.autoScrollToggle.checked && !q && filtered.length !== lastRenderedCount) {
      els.transcript.scrollTop = els.transcript.scrollHeight;
    }
    lastRenderedCount = filtered.length;
  }

  function render() {
    const items = state?.segments || [];
    const recording = Boolean(state?.recording);
    const status = state?.serverStatus || "unknown";

    if (recording) {
      els.statusBadge.textContent = ["capturing","connected"].includes(status) ? "STT 기록 중" : "연결 중";
      els.statusBadge.className = "badge live";
    } else if (items.length) {
      els.statusBadge.textContent = "중지됨";
      els.statusBadge.className = "badge idle";
    } else {
      els.statusBadge.textContent = "준비";
      els.statusBadge.className = "badge ready";
    }

    els.videoTitle.textContent = state?.metadata?.title || "YouTube 라이브를 열어주세요.";
    const channel = state?.metadata?.channel ? ` · ${state.metadata.channel}` : "";
    els.videoMeta.textContent = state?.metadata ? `${state.metadata.videoId || "YouTube"}${channel}` : "CC가 없어도 탭 오디오로 인식합니다.";

    const allText = items.map(x => x.text).join(" ").trim();
    els.segmentCount.textContent = String(items.length);
    els.wordCount.textContent = allText ? String(allText.split(/\s+/).filter(Boolean).length) : "0";
    els.lastTime.textContent = formatClock(items.at(-1)?.end || 0);
    els.overlayToggle.checked = Boolean(state?.overlayEnabled);

    els.startBtn.disabled = recording;
    els.stopBtn.disabled = !recording;
    els.clearBtn.disabled = !recording && !items.length;
    els.exportButtons.forEach(b => b.disabled = !items.length);

    if (state?.error) showNotice(state.error);
    renderTranscript();
  }

  function safeFilename(value) {
    return String(value || "youtube-live-transcript")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90) || "youtube-live-transcript";
  }

  function buildExport(format) {
    const items = state?.segments || [];
    const meta = state?.metadata || {};
    if (format === "txt") {
      const header = `# ${meta.title || "YouTube Live Transcript"}\n# ${meta.url || ""}\n# Started: ${state?.startedAt || ""}\n\n`;
      return {
        ext: "txt", mime: "text/plain;charset=utf-8",
        content: header + items.map(x => `[${formatClock(x.start)}] ${x.text}`).join("\n")
      };
    }
    if (format === "srt") {
      return {
        ext:"srt", mime:"application/x-subrip;charset=utf-8",
        content: items.map((x,i) => `${i+1}\n${srtTime(x.start)} --> ${srtTime(x.end)}\n${x.text}\n`).join("\n")
      };
    }
    if (format === "vtt") {
      return {
        ext:"vtt", mime:"text/vtt;charset=utf-8",
        content: "WEBVTT\n\n" + items.map(x => `${srtTime(x.start).replace(",",".")} --> ${srtTime(x.end).replace(",",".")}\n${x.text}\n`).join("\n")
      };
    }
    return {
      ext:"json", mime:"application/json;charset=utf-8",
      content: JSON.stringify({
        metadata: meta,
        startedAt: state?.startedAt || null,
        stoppedAt: state?.stoppedAt || null,
        exportedAt: new Date().toISOString(),
        segments: items
      }, null, 2)
    };
  }

  async function download(format) {
    const file = buildExport(format);
    const blob = new Blob([file.content], { type: file.mime });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0,10);
    try {
      await chrome.downloads.download({
        url,
        filename: `${safeFilename(state?.metadata?.title)}_${date}.${file.ext}`,
        saveAs: true
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  }

  els.viewModeBtn.addEventListener("click", async () => {
    try {
      if (!isWindowMode) {
        const response = await chrome.runtime.sendMessage({
          type: "YTLT_OPEN_DETACHED",
          target: "background"
        });
        if (!response?.ok) {
          throw new Error(response?.error || "독립 창을 열지 못했습니다.");
        }
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
    showNotice("Chrome의 activeTab/tabCapture 권한 제약 때문에 새 캡처는 Side Panel에서 직접 시작할 수 없습니다. YouTube 탭에서 툴바의 YT Live STT 확장 아이콘을 누른 뒤 ‘현재 YouTube 탭 STT 시작’을 눌러주세요.");
  });

  els.stopBtn.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({ type:"YTLT_STT_STOP", target:"background" });
    if (response?.ok) state = response.state;
    render();
  });

  els.clearBtn.addEventListener("click", async () => {
    if (!confirm("현재 저장된 전사 기록을 모두 지울까요?")) return;
    const response = await chrome.runtime.sendMessage({ type:"YTLT_CLEAR", target:"background" });
    if (response?.ok) state = response.state;
    render();
  });

  els.overlayToggle.addEventListener("change", async () => {
    const response = await chrome.runtime.sendMessage({
      type:"YTLT_SET_OVERLAY", target:"background", enabled:els.overlayToggle.checked
    });
    if (response?.ok) state = response.state;
    render();
  });

  els.searchInput.addEventListener("input", renderTranscript);
  els.autoScrollToggle.addEventListener("change", renderTranscript);
  els.exportButtons.forEach(btn => btn.addEventListener("click", () => download(btn.dataset.format)));

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "YTLT_STATE" && message?.target === "ui") {
      state = message.state;
      render();
    }
  });

  Promise.all([refreshState(), checkServer()]).catch(console.error);
})();

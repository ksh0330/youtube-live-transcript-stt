const OFFSCREEN_PATH = "offscreen.html";
const STORAGE_KEY = "ytlt:stt:session";

let creatingOffscreen = null;
let session = null;
let loaded = false;
let detachedWindowId = null;

async function loadSession() {
  if (loaded) return;
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  session = saved[STORAGE_KEY] || {
    recording: false,
    tabId: null,
    startedAt: null,
    stoppedAt: null,
    metadata: null,
    segments: [],
    overlayEnabled: false,
    serverStatus: "unknown",
    error: null
  };

  // A service-worker/browser restart means the old MediaStream must not be
  // assumed to still exist.
  if (session.recording) {
    session.recording = false;
    session.stoppedAt = new Date().toISOString();
    session.error = "브라우저/확장 프로그램 재시작으로 이전 캡처가 중단되었습니다.";
  }
  loaded = true;
}

async function persist() {
  await loadSession();
  await chrome.storage.local.set({ [STORAGE_KEY]: session });
}

async function broadcast() {
  await persist();
  try {
    await chrome.runtime.sendMessage({
      type: "YTLT_STATE",
      target: "ui",
      state: session
    });
  } catch (_) {}
}

async function ensureOffscreen() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Capture a user-authorized YouTube tab audio stream and send PCM to the local speech-to-text server."
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function getPageInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "YTLT_GET_PAGE_INFO" });
    if (response?.ok) return response.info;
  } catch (_) {}

  const tab = await chrome.tabs.get(tabId);
  return {
    title: tab.title || "YouTube",
    url: tab.url || "",
    videoId: null,
    channel: "",
    currentTime: null,
    paused: null
  };
}

async function currentVideoTime(tabId) {
  const info = await getPageInfo(tabId);
  return Number.isFinite(info?.currentTime) ? info.currentTime : null;
}

async function startCaptureWithStream(streamId, tabId) {
  await loadSession();

  if (!streamId) {
    throw new Error("Chrome 탭 캡처 권한이 없습니다. 툴바의 확장 프로그램 아이콘에서 다시 시작하세요.");
  }
  if (!Number.isInteger(tabId)) {
    throw new Error("캡처할 YouTube 탭을 찾지 못했습니다.");
  }

  if (session.recording) {
    await stopCapture();
  }

  // The launcher creates the offscreen document before requesting streamId,
  // but ensure it again in case Chrome disposed the document.
  await ensureOffscreen();

  const tab = await chrome.tabs.get(tabId);
  const info = await getPageInfo(tabId);

  session = {
    recording: true,
    tabId,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    metadata: {
      title: info.title || tab.title || "YouTube",
      url: info.url || tab.url || "",
      videoId: info.videoId || null,
      channel: info.channel || ""
    },
    segments: [],
    overlayEnabled: Boolean(session?.overlayEnabled),
    serverStatus: "connecting",
    error: null
  };
  await broadcast();

  const response = await chrome.runtime.sendMessage({
    type: "YTLT_OFFSCREEN_START",
    target: "offscreen",
    streamId,
    wsUrl: "ws://127.0.0.1:8765/ws/transcribe",
    language: "ko"
  });

  if (!response?.ok) {
    session.recording = false;
    session.stoppedAt = new Date().toISOString();
    session.error = response?.error || "오디오 캡처 시작 실패";
    await broadcast();
    throw new Error(session.error);
  }

  return session;
}

async function stopCapture(reason = null) {
  await loadSession();
  try {
    await chrome.runtime.sendMessage({
      type: "YTLT_OFFSCREEN_STOP",
      target: "offscreen"
    });
  } catch (_) {}

  session.recording = false;
  session.stoppedAt = new Date().toISOString();
  if (reason) session.error = reason;
  await broadcast();
  return session;
}

async function clearSession() {
  await stopCapture();
  const overlayEnabled = Boolean(session?.overlayEnabled);
  session = {
    recording: false,
    tabId: null,
    startedAt: null,
    stoppedAt: null,
    metadata: null,
    segments: [],
    overlayEnabled,
    serverStatus: "unknown",
    error: null
  };
  await broadcast();
  return session;
}

async function updateOverlay(enabled) {
  await loadSession();
  session.overlayEnabled = Boolean(enabled);

  if (session.tabId) {
    const latest = session.segments.at(-1)?.text || "";
    try {
      await chrome.tabs.sendMessage(session.tabId, {
        type: "YTLT_OVERLAY_TEXT",
        enabled: Boolean(enabled),
        text: enabled ? latest : ""
      });
    } catch (_) {}
  }

  await broadcast();
  return session;
}

async function appendTranscript(message) {
  await loadSession();
  if (!session.recording || !session.tabId) return;

  const text = String(message.text || "").replace(/\s+/g, " ").trim();
  if (!text) return;

  const nowVideo = await currentVideoTime(session.tabId);
  const newSeconds = Math.max(0.5, Number(message.new_seconds) || 5);
  const last = session.segments.at(-1);

  let end;
  if (Number.isFinite(nowVideo)) {
    end = Math.max(0, nowVideo);
  } else if (last) {
    end = last.end + newSeconds;
  } else {
    end = newSeconds;
  }

  let start = Math.max(0, end - newSeconds);
  if (last && start < last.end - 0.5) {
    start = Math.max(0, last.end - 0.5);
  }
  if (end <= start) end = start + 0.5;

  session.segments.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    start,
    end,
    text,
    observedAt: new Date().toISOString(),
    raw: message.raw || text,
    sequence: Number(message.sequence) || session.segments.length + 1
  });

  session.serverStatus = "connected";
  session.error = null;

  if (session.overlayEnabled) {
    try {
      await chrome.tabs.sendMessage(session.tabId, {
        type: "YTLT_OVERLAY_TEXT",
        enabled: true,
        text
      });
    } catch (_) {}
  }

  await broadcast();
}


async function openDetachedWindow() {
  const targetUrl = chrome.runtime.getURL("sidepanel.html?mode=window");

  if (detachedWindowId !== null) {
    try {
      const existing = await chrome.windows.get(detachedWindowId);
      if (existing) {
        await chrome.windows.update(detachedWindowId, {
          focused: true,
          state: "normal"
        });
        return { windowId: detachedWindowId, reused: true };
      }
    } catch (_) {
      detachedWindowId = null;
    }
  }

  const created = await chrome.windows.create({
    url: targetUrl,
    type: "popup",
    width: 560,
    height: 920,
    focused: true
  });

  detachedWindowId = created?.id ?? null;
  return { windowId: detachedWindowId, reused: false };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target === "offscreen") return;

  const run = async () => {
    switch (message.type) {
      case "YTLT_PREPARE_CAPTURE":
        await loadSession();
        await ensureOffscreen();

        // If the stored app state says we are not recording, proactively stop
        // any orphaned MediaStream left by a previous failed inference.
        if (!session.recording) {
          try {
            await chrome.runtime.sendMessage({
              type: "YTLT_OFFSCREEN_STOP",
              target: "offscreen"
            });
          } catch (_) {}
        }

        sendResponse({ ok: true, recording: Boolean(session.recording) });
        return;

      case "YTLT_GET_APP_STATE":
        await loadSession();
        sendResponse({ ok: true, state: session });
        return;

      case "YTLT_OPEN_DETACHED":
        try {
          const result = await openDetachedWindow();
          sendResponse({ ok: true, ...result });
        } catch (error) {
          sendResponse({ ok: false, error: String(error?.message || error) });
        }
        return;

      case "YTLT_STT_START_WITH_STREAM":
        try {
          const state = await startCaptureWithStream(message.streamId, message.tabId);
          sendResponse({ ok: true, state });
        } catch (error) {
          sendResponse({
            ok: false,
            error: String(error?.message || error),
            state: session
          });
        }
        return;

      // Side Panel itself cannot reliably acquire a fresh activeTab grant.
      case "YTLT_STT_START":
        sendResponse({
          ok: false,
          error: "Chrome 보안 정책상 새 오디오 캡처는 툴바의 확장 프로그램 아이콘에서 시작해야 합니다.",
          state: session
        });
        return;

      case "YTLT_STT_STOP":
        sendResponse({ ok: true, state: await stopCapture() });
        return;

      case "YTLT_FORCE_RELEASE_CAPTURE":
        try {
          await ensureOffscreen();
          await chrome.runtime.sendMessage({
            type: "YTLT_OFFSCREEN_STOP",
            target: "offscreen"
          });
        } catch (_) {}
        await loadSession();
        session.recording = false;
        session.stoppedAt = new Date().toISOString();
        session.serverStatus = "stopped";
        session.error = null;
        await broadcast();
        sendResponse({ ok: true, state: session });
        return;

      case "YTLT_CLEAR":
        sendResponse({ ok: true, state: await clearSession() });
        return;

      case "YTLT_SET_OVERLAY":
        sendResponse({ ok: true, state: await updateOverlay(message.enabled) });
        return;

      case "YTLT_OFFSCREEN_STATUS":
        await loadSession();
        session.serverStatus = message.status || "unknown";
        if (message.error) session.error = message.error;
        await broadcast();
        sendResponse({ ok: true });
        return;

      case "YTLT_OFFSCREEN_TRANSCRIPT":
        await appendTranscript(message);
        sendResponse({ ok: true });
        return;

      case "YTLT_OFFSCREEN_ERROR":
        await loadSession();
        session.recording = false;
        session.stoppedAt = new Date().toISOString();
        session.serverStatus = "error";
        session.error = message.error || "STT 처리 오류";
        await broadcast();
        sendResponse({ ok: true });
        return;
    }
  };

  run().catch((error) => {
    console.error("[YT Live STT] background message error", error);
    try {
      sendResponse({ ok: false, error: String(error?.message || error) });
    } catch (_) {}
  });

  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadSession();
  if (session.recording && session.tabId === tabId) {
    await stopCapture("캡처 중이던 YouTube 탭이 닫혀 기록을 중지했습니다.");
  }
});


chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === detachedWindowId) {
    detachedWindowId = null;
  }
});

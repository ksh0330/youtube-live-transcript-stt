importScripts("transcript-utils.js");
const utils = globalThis.YTLTUtils;

const OFFSCREEN_PATH = "offscreen.html";
const STORAGE_KEY = "ytlt:stt:session";
const CHECKPOINT_DELAY_MS = 8000;
const DEFAULT_SETTINGS = Object.freeze({
  overlayPosition: "bottom",
  overlaySize: "medium",
  overlayOpacity: 0.8,
  contextPrompt: "",
  // Whisper language (`auto` detects once and locks) and Korean translation.
  language: "auto",
  translateToKorean: true
});
const LANGUAGES = new Set(["auto", "ko", "en", "ja", "zh"]);

let creatingOffscreen = null;
let session = null;
let loaded = false;
let detachedWindowId = null;
let persistTimer = null;
let persistDirty = false;

function normalizedSettings(value = {}) {
  const positions = new Set(["top", "center", "bottom"]);
  const sizes = new Set(["small", "medium", "large"]);
  const opacity = Number(value.overlayOpacity);
  return {
    overlayPosition: positions.has(value.overlayPosition) ? value.overlayPosition : DEFAULT_SETTINGS.overlayPosition,
    overlaySize: sizes.has(value.overlaySize) ? value.overlaySize : DEFAULT_SETTINGS.overlaySize,
    overlayOpacity: [0.5, 0.7, 0.8, 0.9].includes(opacity) ? opacity : DEFAULT_SETTINGS.overlayOpacity,
    contextPrompt: String(value.contextPrompt || "").replace(/\s+/g, " ").trim().slice(0, 1000),
    language: LANGUAGES.has(value.language) ? value.language : DEFAULT_SETTINGS.language,
    translateToKorean: value.translateToKorean !== false
  };
}

function emptySession(settings = DEFAULT_SETTINGS) {
  return {
    sessionId: null,
    recording: false,
    tabId: null,
    startedAt: null,
    stoppedAt: null,
    timelineOrigin: 0,
  resetGeneration: 0,
    metadata: null,
    segments: [],
    provisional: [],
    lastSequence: 0,
    metrics: {
      liveDelay: null,
      inferenceSeconds: null,
      queueSeconds: 0,
      droppedSeconds: 0,
      audioEnd: 0
    },
    overlayEnabled: false,
    settings: normalizedSettings(settings),
    serverStatus: "unknown",
    error: null
  };
}

function normalizeSession(saved) {
  const base = emptySession(saved?.settings);
  const value = saved && typeof saved === "object" ? saved : {};
  return {
    ...base,
    ...value,
    segments: Array.isArray(value.segments) ? value.segments : [],
    provisional: Array.isArray(value.provisional) ? value.provisional : [],
    metrics: { ...base.metrics, ...(value.metrics || {}) },
    settings: normalizedSettings(value.settings),
    overlayEnabled: Boolean(value.overlayEnabled)
  };
}

async function loadSession() {
  if (loaded) return;
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  session = normalizeSession(saved[STORAGE_KEY]);
  let recoveredInterruptedSession = false;

  // A service-worker/browser restart means the previous MediaStream cannot be
  // trusted. Keep its transcript, but make restart state explicit.
  if (session.recording) {
    promoteProvisional();
    session.recording = false;
    session.stoppedAt = new Date().toISOString();
    session.serverStatus = "stopped";
    session.error = "브라우저/확장 프로그램 재시작으로 이전 캡처가 중단되었습니다.";
    persistDirty = true;
    recoveredInterruptedSession = true;
  }
  loaded = true;
  if (recoveredInterruptedSession) schedulePersist();
}

async function persistNow() {
  await loadSession();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistDirty = false;
  await chrome.storage.local.set({ [STORAGE_KEY]: session });
}

function schedulePersist() {
  persistDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (persistDirty) {
      persistNow()
        .then(() => sendRuntimeMessage({ type: "YTLT_STATE", target: "ui", state: session }))
        .catch(console.error);
    }
  }, CHECKPOINT_DELAY_MS);
}

async function sendRuntimeMessage(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch (_) {}
}

async function broadcastFull({ persist = true } = {}) {
  if (persist) await persistNow();
  else schedulePersist();
  await sendRuntimeMessage({ type: "YTLT_STATE", target: "ui", state: session });
}

async function broadcastDelta(delta) {
  schedulePersist();
  await sendRuntimeMessage({ type: "YTLT_TRANSCRIPT_DELTA", target: "ui", delta });
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

// After the extension is reloaded or updated, YouTube tabs that were already
// open keep an orphaned content script that no longer receives messages, so
// the overlay silently stops. Inject the current content script again.
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch (_) {
    return false;
  }
}

async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    if (!(await injectContentScript(tabId))) return null;
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (_) {
      return null;
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/*", "https://youtube.com/*"] });
  await Promise.all(tabs.map(tab => injectContentScript(tab.id)));
});

async function getPageInfo(tabId) {
  const response = await sendToContent(tabId, { type: "YTLT_GET_PAGE_INFO" });
  if (response?.ok) return response.info;

  const tab = await chrome.tabs.get(tabId);
  return {
    title: tab.title || "YouTube",
    url: tab.url || "",
    videoId: videoIdFromUrl(tab.url),
    channel: "",
    currentTime: null,
    paused: null
  };
}

function videoIdFromUrl(url) {
  try {
    const parsed = new URL(url || "");
    if (parsed.pathname === "/watch") return parsed.searchParams.get("v");
    if (parsed.pathname.startsWith("/live/")) return parsed.pathname.split("/")[2] || null;
  } catch (_) {}
  return null;
}

function makeSessionId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Characters per caption line by overlay text size (bigger text, shorter lines).
const OVERLAY_LINE_CHARS = Object.freeze({ small: 30, medium: 26, large: 22 });

function latestOverlayText() {
  const size = session?.settings?.overlaySize;
  return utils.overlayText(session?.segments, session?.provisional, {
    lineChars: OVERLAY_LINE_CHARS[size] || OVERLAY_LINE_CHARS.medium,
    maxLines: 2
  });
}

async function syncOverlay(tabId = session?.tabId) {
  if (!Number.isInteger(tabId)) return;
  const enabled = Boolean(session.overlayEnabled && session.tabId === tabId);
  await sendToContent(tabId, {
    type: "YTLT_OVERLAY_TEXT",
    enabled,
    text: enabled ? latestOverlayText() : "",
    settings: session.settings
  });
}

async function startCaptureWithStream(streamId, tabId) {
  await loadSession();
  if (!streamId) {
    throw new Error("Chrome 탭 캡처 권한이 없습니다. 툴바의 확장 프로그램 아이콘에서 다시 시작하세요.");
  }
  if (!Number.isInteger(tabId)) {
    throw new Error("캡처할 YouTube 탭을 찾지 못했습니다.");
  }
  if (session.recording) await stopCapture();

  await ensureOffscreen();
  const tab = await chrome.tabs.get(tabId);
  const info = await getPageInfo(tabId);
  const retainedSettings = normalizedSettings(session.settings);
  const retainedOverlay = Boolean(session.overlayEnabled);
  session = {
    ...emptySession(retainedSettings),
    sessionId: makeSessionId(),
    recording: true,
    tabId,
    startedAt: new Date().toISOString(),
    timelineOrigin: Number.isFinite(info.currentTime) ? Math.max(0, info.currentTime) : 0,
    resetGeneration: 0,
    metadata: {
      title: info.title || tab.title || "YouTube",
      url: info.url || tab.url || "",
      videoId: info.videoId || null,
      channel: info.channel || ""
    },
    overlayEnabled: retainedOverlay,
    serverStatus: "connecting"
  };
  await broadcastFull();

  const response = await chrome.runtime.sendMessage({
    type: "YTLT_OFFSCREEN_START",
    target: "offscreen",
    sessionId: session.sessionId,
    streamId,
    wsUrl: "ws://127.0.0.1:8765/ws/transcribe",
    language: session.settings.language,
    translateTo: session.settings.translateToKorean ? "ko" : "",
    initialPrompt: session.settings.contextPrompt
  });

  if (!response?.ok) {
    session.recording = false;
    session.stoppedAt = new Date().toISOString();
    session.error = response?.error || "오디오 캡처 시작 실패";
    await broadcastFull();
    throw new Error(session.error);
  }
  await syncOverlay();
  return session;
}

function normalizedIncomingSegment(item, sequence, index) {
  const origin = Number(session?.timelineOrigin) || 0;
  const relativeStart = Math.max(0, Number(item?.start) || 0);
  const relativeEnd = Math.max(relativeStart + 0.05, Number(item?.end) || relativeStart + 0.5);
  const text = String(item?.text || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return {
    id: `${session.sessionId || "session"}-${sequence}-${index}`,
    start: origin + relativeStart,
    end: origin + relativeEnd,
    text,
    raw: item?.raw || text,
    observedAt: new Date().toISOString(),
    sequence,
    ...(item?.stable ? { stable: true } : {}),
    // Set when the text was translated; `original` keeps the spoken text.
    ...(item?.original ? { original: String(item.original).trim() } : {}),
    ...(item?.language ? { language: String(item.language) } : {})
  };
}

function appendFinalized(items, sequence) {
  const appended = [];
  const generation = Number(session.resetGeneration) || 0;
  for (let index = 0; index < items.length; index++) {
    const segment = normalizedIncomingSegment(items[index], sequence, index);
    if (!segment) continue;
    segment.generation = generation;
    // After a jump the timeline restarts, possibly earlier in the video, so
    // only compare against segments from the same position.
    const last = session.segments.at(-1);
    const sameRun = last && (Number(last.generation) || 0) === generation;
    if (sameRun && segment.end <= last.end + 0.03) continue;
    if (sameRun && segment.start < last.end) segment.start = last.end;
    if (segment.end <= segment.start) segment.end = segment.start + 0.05;
    session.segments.push(segment);
    appended.push(segment);
  }
  return appended;
}

function promoteProvisional() {
  if (!session?.provisional?.length) return [];
  return utils.promoteProvisional(session);
}

async function appendTranscriptUpdate(message) {
  await loadSession();
  if (!session.recording || !session.tabId) return;
  if (message.sessionId && message.sessionId !== session.sessionId) return;
  const sequence = Number(message.sequence) || session.lastSequence + 1;
  if (sequence <= session.lastSequence) return;
  // Results for audio from before the last jump would land at the wrong time.
  if ((Number(message.generation) || 0) < (Number(session.resetGeneration) || 0)) return;

  const finalized = appendFinalized(Array.isArray(message.finalized) ? message.finalized : [], sequence);
  session.provisional = (Array.isArray(message.provisional) ? message.provisional : [])
    .map((item, index) => normalizedIncomingSegment(item, sequence, `p${index}`))
    .filter(Boolean)
    .map(item => ({ ...item, provisional: true }));
  session.lastSequence = sequence;
  session.serverStatus = "connected";
  session.error = null;

  const inferenceSeconds = Math.max(0, Number(message.inference_ms) || 0) / 1000;
  const queueSeconds = Math.max(0, Number(message.queue_seconds) || 0);
  const droppedSeconds = Math.max(0, Number(message.dropped_seconds) || 0);
  const audioEnd = (Number(session.timelineOrigin) || 0) + Math.max(0, Number(message.audio_end) || 0);
  let liveDelay = inferenceSeconds + queueSeconds;
  try {
    const info = await getPageInfo(session.tabId);
    if (session.metadata?.videoId && info?.videoId && session.metadata.videoId !== info.videoId) {
      await stopCapture("YouTube 영상이 변경되어 기존 STT 세션을 안전하게 중지했습니다.");
      return;
    }
    // Measure against the newest text on screen. In sentence mode a long
    // sentence is committed only when it ends, so the last final segment
    // alone would overstate the delay.
    const latestShownEnd = Math.max(
      Number(session.segments.at(-1)?.end) || -Infinity,
      ...session.provisional.map(item => Number(item.end) || -Infinity)
    );
    if (Number.isFinite(info?.currentTime) && Number.isFinite(latestShownEnd)) {
      liveDelay = Math.max(0, info.currentTime - latestShownEnd);
    }
  } catch (_) {}

  session.metrics = {
    liveDelay,
    inferenceSeconds,
    queueSeconds,
    droppedSeconds,
    audioEnd,
    language: message.language || session.metrics?.language || null
  };
  await syncOverlay();
  await broadcastDelta({
    sessionId: session.sessionId,
    sequence,
    finalized,
    provisional: session.provisional,
    metrics: session.metrics,
    serverStatus: session.serverStatus,
    error: null
  });
}

// Backward-compatible path for a v0.2.x server.
async function appendLegacyTranscript(message) {
  await loadSession();
  if (!session.recording || !session.tabId) return;
  if (message.sessionId && message.sessionId !== session.sessionId) return;
  const text = String(message.text || "").replace(/\s+/g, " ").trim();
  if (!text) return;
  const info = await getPageInfo(session.tabId);
  const end = Number.isFinite(info.currentTime)
    ? Math.max(0, info.currentTime)
    : (session.segments.at(-1)?.end || 0) + (Number(message.new_seconds) || 5);
  const start = Math.max(session.segments.at(-1)?.end || 0, end - (Number(message.new_seconds) || 5));
  const sequence = Number(message.sequence) || session.lastSequence + 1;
  const segment = {
    id: `${session.sessionId}-${sequence}`,
    start,
    end: Math.max(start + 0.5, end),
    text,
    raw: message.raw || text,
    observedAt: new Date().toISOString(),
    sequence
  };
  session.segments.push(segment);
  session.lastSequence = sequence;
  session.serverStatus = "connected";
  session.provisional = [];
  await syncOverlay();
  await broadcastDelta({
    sessionId: session.sessionId,
    sequence,
    finalized: [segment],
    provisional: [],
    metrics: session.metrics,
    serverStatus: session.serverStatus,
    error: null
  });
}

async function stopCapture(reason = null) {
  await loadSession();
  try {
    await chrome.runtime.sendMessage({ type: "YTLT_OFFSCREEN_STOP", target: "offscreen" });
  } catch (_) {}
  promoteProvisional();
  session.recording = false;
  session.stoppedAt = new Date().toISOString();
  session.serverStatus = reason ? "error" : "stopped";
  if (reason) session.error = reason;
  await syncOverlay();
  await broadcastFull();
  return session;
}

async function clearSession() {
  await stopCapture();
  const oldTabId = session.tabId;
  const settings = normalizedSettings(session.settings);
  const overlayEnabled = Boolean(session.overlayEnabled);
  session = { ...emptySession(settings), overlayEnabled };
  if (Number.isInteger(oldTabId)) {
    try {
      await chrome.tabs.sendMessage(oldTabId, {
        type: "YTLT_OVERLAY_TEXT",
        enabled: false,
        text: "",
        settings
      });
    } catch (_) {}
  }
  await broadcastFull();
  return session;
}

async function updateOverlay(enabled) {
  await loadSession();
  session.overlayEnabled = Boolean(enabled);
  await syncOverlay();
  await broadcastFull();
  return session;
}

async function updateSettings(patch) {
  await loadSession();
  session.settings = normalizedSettings({ ...session.settings, ...(patch || {}) });
  await syncOverlay();
  await broadcastFull();
  return session;
}

async function openDetachedWindow() {
  const targetUrl = chrome.runtime.getURL("sidepanel.html?mode=window");
  if (detachedWindowId !== null) {
    try {
      const existing = await chrome.windows.get(detachedWindowId);
      if (existing) {
        await chrome.windows.update(detachedWindowId, { focused: true, state: "normal" });
        return { windowId: detachedWindowId, reused: true };
      }
    } catch (_) {
      detachedWindowId = null;
    }
  }
  const created = await chrome.windows.create({
    url: targetUrl,
    type: "popup",
    width: 620,
    height: 920,
    focused: true
  });
  detachedWindowId = created?.id ?? null;
  return { windowId: detachedWindowId, reused: false };
}

// The viewer sought, skipped or an ad ended: restart recognition at the new
// position instead of mixing audio (and the detected language) from both.
async function handleVideoJump(message, sender) {
  await loadSession();
  const tabId = sender?.tab?.id;
  if (!session.recording || session.tabId !== tabId) return { ok: true, ignored: true };
  const generation = (Number(session.resetGeneration) || 0) + 1;
  let response = null;
  try {
    response = await chrome.runtime.sendMessage({
      type: "YTLT_OFFSCREEN_RESET",
      target: "offscreen",
      generation
    });
  } catch (_) {}
  if (!response?.ok) return { ok: false };

  promoteProvisional();
  session.provisional = [];
  session.resetGeneration = generation;
  // Server audio time `audioSeconds` now corresponds to this video time.
  const videoTime = Number.isFinite(message.currentTime) ? message.currentTime : null;
  if (videoTime !== null) {
    session.timelineOrigin = Math.max(0, videoTime - (Number(response.audioSeconds) || 0));
  }
  await broadcastFull();
  await syncOverlay();
  return { ok: true, generation };
}

async function handleContentReady(message, sender) {
  await loadSession();
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false };
  const info = message.info || await getPageInfo(tabId);
  if (session.recording && session.tabId === tabId) {
    const oldVideoId = session.metadata?.videoId;
    if (message.type === "YTLT_PAGE_CHANGED" && oldVideoId && info?.videoId && oldVideoId !== info.videoId) {
      await stopCapture("YouTube 영상이 변경되어 기존 STT 세션을 안전하게 중지했습니다.");
    } else {
      session.metadata = {
        ...session.metadata,
        title: info?.title || session.metadata?.title,
        channel: info?.channel || session.metadata?.channel,
        url: info?.url || session.metadata?.url
      };
    }
  }
  await syncOverlay(tabId);
  return {
    ok: true,
    enabled: Boolean(session.overlayEnabled && session.tabId === tabId),
    text: session.tabId === tabId ? latestOverlayText() : "",
    settings: session.settings
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === "offscreen") return;

  const run = async () => {
    switch (message.type) {
      case "YTLT_PREPARE_CAPTURE":
        await loadSession();
        await ensureOffscreen();
        if (!session.recording) {
          try {
            await chrome.runtime.sendMessage({ type: "YTLT_OFFSCREEN_STOP", target: "offscreen" });
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
          sendResponse({ ok: true, ...(await openDetachedWindow()) });
        } catch (error) {
          sendResponse({ ok: false, error: String(error?.message || error) });
        }
        return;

      case "YTLT_STT_START_WITH_STREAM":
        try {
          sendResponse({ ok: true, state: await startCaptureWithStream(message.streamId, message.tabId) });
        } catch (error) {
          sendResponse({ ok: false, error: String(error?.message || error), state: session });
        }
        return;

      case "YTLT_STT_START":
        sendResponse({
          ok: false,
          error: "새 STT 시작은 Chrome 툴바의 YT Live STT 아이콘에서 실행하세요.",
          state: session
        });
        return;

      case "YTLT_STT_STOP":
        sendResponse({ ok: true, state: await stopCapture() });
        return;

      case "YTLT_FORCE_RELEASE_CAPTURE":
        try {
          await ensureOffscreen();
          await chrome.runtime.sendMessage({ type: "YTLT_OFFSCREEN_STOP", target: "offscreen" });
        } catch (_) {}
        await loadSession();
        promoteProvisional();
        session.recording = false;
        session.stoppedAt = new Date().toISOString();
        session.serverStatus = "stopped";
        session.error = null;
        await broadcastFull();
        sendResponse({ ok: true, state: session });
        return;

      case "YTLT_CLEAR":
        sendResponse({ ok: true, state: await clearSession() });
        return;

      case "YTLT_SET_OVERLAY":
        sendResponse({ ok: true, state: await updateOverlay(message.enabled) });
        return;

      case "YTLT_SET_SETTINGS":
        sendResponse({ ok: true, state: await updateSettings(message.settings) });
        return;

      case "YTLT_VIDEO_JUMPED":
        sendResponse(await handleVideoJump(message, sender));
        return;

      case "YTLT_CONTENT_READY":
      case "YTLT_PAGE_CHANGED":
        sendResponse(await handleContentReady(message, sender));
        return;

      case "YTLT_OFFSCREEN_STATUS":
        await loadSession();
        if (message.sessionId && message.sessionId !== session.sessionId) {
          sendResponse({ ok: true, ignored: true });
          return;
        }
        session.serverStatus = message.status || "unknown";
        if (message.error) session.error = message.error;
        if (message.status === "disconnected" && session.recording) {
          promoteProvisional();
          session.recording = false;
          session.stoppedAt = new Date().toISOString();
          session.error = message.error || "STT 서버 연결이 종료되었습니다. 서버를 확인한 뒤 다시 시작하세요.";
        }
        await broadcastFull({ persist: message.status === "disconnected" });
        sendResponse({ ok: true });
        return;

      case "YTLT_OFFSCREEN_TRANSCRIPT_UPDATE":
        await appendTranscriptUpdate(message);
        sendResponse({ ok: true });
        return;

      case "YTLT_OFFSCREEN_TRANSCRIPT":
        await appendLegacyTranscript(message);
        sendResponse({ ok: true });
        return;

      case "YTLT_OFFSCREEN_ERROR":
        await loadSession();
        if (message.sessionId && message.sessionId !== session.sessionId) {
          sendResponse({ ok: true, ignored: true });
          return;
        }
        promoteProvisional();
        session.recording = false;
        session.stoppedAt = new Date().toISOString();
        session.serverStatus = "error";
        session.error = message.error || "STT 처리 오류";
        await broadcastFull();
        sendResponse({ ok: true });
        return;
    }
  };

  run().catch((error) => {
    console.error("[YT Live STT] background message error", error);
    try { sendResponse({ ok: false, error: String(error?.message || error) }); } catch (_) {}
  });
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadSession();
  if (session.recording && session.tabId === tabId) {
    await stopCapture("캡처 중이던 YouTube 탭이 닫혀 기록을 중지했습니다.");
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  await loadSession();
  if (!session.recording || session.tabId !== tabId) return;
  const oldVideoId = session.metadata?.videoId;
  if (oldVideoId && videoIdFromUrl(changeInfo.url) !== oldVideoId) {
    await stopCapture("YouTube 영상 또는 페이지가 변경되어 기존 STT 세션을 안전하게 중지했습니다.");
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === detachedWindowId) detachedWindowId = null;
});

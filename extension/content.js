(() => {
  "use strict";
  if (globalThis.__YTLT_STT_CONTENT__) return;
  globalThis.__YTLT_STT_CONTENT__ = true;

  function getVideo() {
    return document.querySelector("video.html5-main-video, video");
  }

  function getInfo() {
    const video = getVideo();
    let videoId = null;
    try { videoId = new URL(location.href).searchParams.get("v"); } catch (_) {}

    const title =
      document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent?.trim() ||
      document.querySelector("h1.title yt-formatted-string")?.textContent?.trim() ||
      document.title.replace(/\s*-\s*YouTube\s*$/i, "").trim() ||
      "YouTube";

    const channel =
      document.querySelector("ytd-channel-name a")?.textContent?.trim() ||
      document.querySelector("#owner-name a")?.textContent?.trim() ||
      "";

    return {
      title,
      channel,
      url: location.href,
      videoId,
      currentTime: video && Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : null,
      paused: video ? video.paused : null
    };
  }

  function renderOverlay(enabled, text) {
    let node = document.getElementById("ytlt-stt-overlay");
    if (!enabled) {
      node?.remove();
      return;
    }

    if (!node) {
      node = document.createElement("div");
      node.id = "ytlt-stt-overlay";
      node.setAttribute("aria-live", "polite");
      Object.assign(node.style, {
        position: "fixed",
        left: "50%",
        bottom: "13%",
        transform: "translateX(-50%)",
        zIndex: "2147483647",
        maxWidth: "min(960px, 84vw)",
        padding: "11px 15px",
        borderRadius: "10px",
        background: "rgba(0,0,0,.80)",
        color: "#fff",
        fontSize: "18px",
        lineHeight: "1.5",
        fontFamily: "Arial, sans-serif",
        textAlign: "center",
        pointerEvents: "none",
        boxShadow: "0 6px 24px rgba(0,0,0,.30)",
        whiteSpace: "pre-wrap"
      });
      document.documentElement.appendChild(node);
    }
    node.textContent = text || "음성을 인식하는 중…";
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "YTLT_GET_PAGE_INFO") {
      sendResponse({ ok: true, info: getInfo() });
      return;
    }
    if (message?.type === "YTLT_OVERLAY_TEXT") {
      renderOverlay(Boolean(message.enabled), String(message.text || ""));
      sendResponse({ ok: true });
    }
  });
})();

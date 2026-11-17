(() => {
  "use strict";
  if (globalThis.__YTLT_STT_CONTENT__) return;
  globalThis.__YTLT_STT_CONTENT__ = true;

  const OVERLAY_ID = "ytlt-stt-overlay";
  const DEFAULT_SETTINGS = {
    overlayPosition: "bottom",
    overlaySize: "medium",
    overlayOpacity: 0.8
  };
  let overlayState = { enabled: false, text: "", settings: DEFAULT_SETTINGS };
  let playerObserver = null;
  let observedPlayer = null;

  function getVideo() {
    return document.querySelector("video.html5-main-video, video");
  }

  function getPlayer() {
    return document.querySelector("#movie_player") || getVideo()?.parentElement || null;
  }

  function getInfo() {
    const video = getVideo();
    let videoId = null;
    try {
      const url = new URL(location.href);
      videoId = url.searchParams.get("v") || (url.pathname.startsWith("/live/") ? url.pathname.split("/")[2] : null);
    } catch (_) {}

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

  function controlsVisible(player) {
    return Boolean(player && !player.classList.contains("ytp-autohide"));
  }

  function applyPosition(node, player, position) {
    node.style.top = "auto";
    node.style.bottom = "auto";
    node.style.transform = "translateX(-50%)";
    if (position === "top") {
      node.style.top = "10%";
    } else if (position === "center") {
      node.style.top = "50%";
      node.style.transform = "translate(-50%, -50%)";
    } else {
      node.style.bottom = controlsVisible(player) ? "18%" : "11%";
    }
  }

  function observePlayer(player) {
    if (observedPlayer === player) return;
    playerObserver?.disconnect();
    observedPlayer = player;
    if (!player) return;
    playerObserver = new MutationObserver(() => {
      const node = document.getElementById(OVERLAY_ID);
      if (node && overlayState.enabled) {
        applyPosition(node, player, overlayState.settings.overlayPosition);
      }
    });
    playerObserver.observe(player, { attributes: true, attributeFilter: ["class"] });
  }

  function renderOverlay(enabled, text, settings = {}) {
    overlayState = {
      enabled: Boolean(enabled),
      text: String(text || ""),
      settings: { ...DEFAULT_SETTINGS, ...(settings || {}) }
    };
    let node = document.getElementById(OVERLAY_ID);
    if (!overlayState.enabled) {
      node?.remove();
      return;
    }

    const player = getPlayer();
    if (!player) return;
    observePlayer(player);
    if (!node) {
      node = document.createElement("div");
      node.id = OVERLAY_ID;
      node.setAttribute("aria-live", "polite");
    }
    if (node.parentElement !== player) player.appendChild(node);

    const sizeMap = { small: "15px", medium: "18px", large: "22px" };
    const opacity = Math.max(0.5, Math.min(0.9, Number(overlayState.settings.overlayOpacity) || 0.8));
    Object.assign(node.style, {
      position: "absolute",
      left: "50%",
      zIndex: "2147483647",
      width: "max-content",
      maxWidth: "min(960px, 84%)",
      padding: "6px 14px",
      borderRadius: "6px",
      background: `rgba(0,0,0,${opacity})`,
      color: "#fff",
      fontSize: sizeMap[overlayState.settings.overlaySize] || sizeMap.medium,
      lineHeight: "1.5",
      fontFamily: "Arial, sans-serif",
      textAlign: "center",
      pointerEvents: "none",
      boxShadow: "0 6px 24px rgba(0,0,0,.30)",
      // Background sends at most two short lines (YouTube-CC-like roll-up).
      whiteSpace: "pre-line",
      overflow: "hidden"
    });
    applyPosition(node, player, overlayState.settings.overlayPosition);
    node.textContent = overlayState.text || "음성을 인식하는 중…";
  }

  async function syncFromBackground(type) {
    try {
      const response = await chrome.runtime.sendMessage({
        type,
        target: "background",
        info: getInfo()
      });
      if (response?.ok) {
        renderOverlay(response.enabled, response.text, response.settings);
      }
    } catch (_) {}
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "YTLT_GET_PAGE_INFO") {
      sendResponse({ ok: true, info: getInfo() });
      return;
    }
    if (message?.type === "YTLT_OVERLAY_TEXT") {
      renderOverlay(Boolean(message.enabled), String(message.text || ""), message.settings);
      sendResponse({ ok: true });
    }
  });

  document.addEventListener("yt-navigate-finish", () => {
    setTimeout(() => syncFromBackground("YTLT_PAGE_CHANGED"), 250);
  });
  document.addEventListener("fullscreenchange", () => {
    if (overlayState.enabled) renderOverlay(true, overlayState.text, overlayState.settings);
  });

  syncFromBackground("YTLT_CONTENT_READY");
})();

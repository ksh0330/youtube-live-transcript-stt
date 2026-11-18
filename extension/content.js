(() => {
  "use strict";
  // Skip only if a live copy is already running. A copy left over from before
  // an extension reload is orphaned (its chrome.runtime.id is gone), so a
  // freshly injected copy takes over.
  const existing = globalThis.__YTLT_STT_CONTENT__;
  if (typeof existing === "function" && existing()) return;
  globalThis.__YTLT_STT_CONTENT__ = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (_) {
      return false;
    }
  };

  const OVERLAY_ID = "ytlt-stt-overlay";
  const DEFAULT_SETTINGS = {
    overlayPosition: "bottom",
    overlaySize: "medium",
    overlayOpacity: 0.8
  };
  let overlayState = { enabled: false, text: "", settings: DEFAULT_SETTINGS };
  let playerObserver = null;
  let observedPlayer = null;
  let sizeObserver = null;

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
    // Re-render on resize so the caption size follows the player.
    sizeObserver?.disconnect();
    let lastHeight = player.clientHeight;
    sizeObserver = new ResizeObserver(() => {
      if (Math.abs(player.clientHeight - lastHeight) < 8) return;
      lastHeight = player.clientHeight;
      if (overlayState.enabled) renderOverlay(true, overlayState.text, overlayState.settings);
    });
    sizeObserver.observe(player);
  }

  // Seeking, skipping or an ad ending makes the video time jump. Tell the
  // background so the server drops audio from the old position and the
  // timeline restarts at the new one.
  let watchedVideo = null;
  let lastVideoTime = null;
  let lastWallTime = 0;
  let lastAdShowing = false;
  let jumpTimer = null;

  function resetVideoBaseline() {
    const video = getVideo();
    lastVideoTime = video && Number.isFinite(video.currentTime) ? video.currentTime : null;
    lastWallTime = performance.now();
  }

  function reportJump() {
    clearTimeout(jumpTimer);
    // Dragging the seek bar fires many events; report once it settles.
    jumpTimer = setTimeout(() => {
      const video = getVideo();
      try {
        chrome.runtime.sendMessage({
          type: "YTLT_VIDEO_JUMPED",
          target: "background",
          currentTime: video && Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : null,
          adShowing: lastAdShowing
        }).catch(() => {});
      } catch (_) {} // this copy was orphaned by an extension reload
    }, 700);
  }

  function checkVideoTime() {
    const video = getVideo();
    if (!video || !Number.isFinite(video.currentTime)) return;
    const now = performance.now();
    const adShowing = Boolean(getPlayer()?.classList.contains("ad-showing"));
    if (lastVideoTime !== null) {
      const expected = lastVideoTime + ((now - lastWallTime) / 1000) * (video.playbackRate || 1);
      if (Math.abs(video.currentTime - expected) > 2.5 || adShowing !== lastAdShowing) {
        lastAdShowing = adShowing;
        reportJump();
      }
    }
    lastAdShowing = adShowing;
    lastVideoTime = video.currentTime;
    lastWallTime = now;
  }

  function watchVideo() {
    const video = getVideo();
    if (!video || video === watchedVideo) return;
    watchedVideo = video;
    video.addEventListener("timeupdate", checkVideoTime);
    video.addEventListener("seeked", checkVideoTime);
    // Time stands still while paused or buffering: not a jump.
    for (const name of ["pause", "play", "playing", "waiting", "ratechange"]) {
      video.addEventListener(name, resetVideoBaseline);
    }
    resetVideoBaseline();
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
    watchVideo();
    if (!node) {
      node = document.createElement("div");
      node.id = OVERLAY_ID;
      node.setAttribute("aria-live", "polite");
    }
    if (node.parentElement !== player) player.appendChild(node);

    // Sizes are for a normal ~480 px tall player; scale up with the player
    // (theater mode, fullscreen) like YouTube's own captions do.
    const sizeMap = { small: 15, medium: 18, large: 22 };
    const scale = Math.max(1, Math.min(2.2, (player.clientHeight || 480) / 480));
    const baseSize = sizeMap[overlayState.settings.overlaySize] || sizeMap.medium;
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
      fontSize: `${Math.round(baseSize * scale)}px`,
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
    setTimeout(() => {
      watchVideo();
      syncFromBackground("YTLT_PAGE_CHANGED");
    }, 250);
  });
  watchVideo();
  document.addEventListener("fullscreenchange", () => {
    if (overlayState.enabled) renderOverlay(true, overlayState.text, overlayState.settings);
  });

  syncFromBackground("YTLT_CONTENT_READY");
})();

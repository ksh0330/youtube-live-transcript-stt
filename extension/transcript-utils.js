((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YTLTUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  function formatClock(seconds) {
    const whole = Math.floor(Math.max(0, Number(seconds) || 0));
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    return [h, m, s].map(value => String(value).padStart(2, "0")).join(":");
  }

  function subtitleTime(seconds, separator = ",") {
    const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const fraction = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${separator}${String(fraction).padStart(3, "0")}`;
  }

  function safeFilename(value) {
    let name = String(value || "youtube-live-transcript")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "")
      .slice(0, 90);
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`;
    return name || "youtube-live-transcript";
  }

  function cleanSegments(items) {
    const cleaned = [];
    let previousEnd = 0;
    for (const item of Array.isArray(items) ? items : []) {
      const text = String(item?.text || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const sourceStart = Math.max(0, Number(item.start) || 0);
      const start = Math.max(previousEnd, sourceStart);
      const end = Math.max(start + 0.05, Number(item.end) || start + 0.5);
      cleaned.push({ ...item, start, end, text });
      previousEnd = end;
    }
    return cleaned;
  }

  function buildExport(state, format) {
    const items = cleanSegments(state?.segments);
    const meta = state?.metadata || {};
    if (format === "txt") {
      const header = `# ${meta.title || "YouTube Live Transcript"}\n# ${meta.url || ""}\n# Started: ${state?.startedAt || ""}\n\n`;
      return {
        ext: "txt",
        mime: "text/plain;charset=utf-8",
        content: header + items.map(item => `[${formatClock(item.start)}] ${item.text}`).join("\n")
      };
    }
    if (format === "srt") {
      return {
        ext: "srt",
        mime: "application/x-subrip;charset=utf-8",
        content: items.map((item, index) => `${index + 1}\n${subtitleTime(item.start)} --> ${subtitleTime(item.end)}\n${item.text}\n`).join("\n")
      };
    }
    if (format === "vtt") {
      return {
        ext: "vtt",
        mime: "text/vtt;charset=utf-8",
        content: "WEBVTT\n\n" + items.map(item => `${subtitleTime(item.start, ".")} --> ${subtitleTime(item.end, ".")}\n${item.text}\n`).join("\n")
      };
    }
    return {
      ext: "json",
      mime: "application/json;charset=utf-8",
      content: JSON.stringify({
        metadata: meta,
        startedAt: state?.startedAt || null,
        stoppedAt: state?.stoppedAt || null,
        exportedAt: new Date().toISOString(),
        segments: items
      }, null, 2)
    };
  }

  function applyTranscriptDelta(state, delta) {
    if (!state || !delta || (delta.sessionId && state.sessionId !== delta.sessionId)) return false;
    const sequence = Number(delta.sequence) || 0;
    if (sequence <= (Number(state.lastSequence) || 0)) return false;
    state.segments = Array.isArray(state.segments) ? state.segments : [];
    state.segments.push(...(Array.isArray(delta.finalized) ? delta.finalized : []));
    state.provisional = Array.isArray(delta.provisional) ? delta.provisional : [];
    state.metrics = { ...(state.metrics || {}), ...(delta.metrics || {}) };
    state.serverStatus = delta.serverStatus || state.serverStatus;
    state.error = delta.error ?? state.error;
    state.lastSequence = sequence;
    return true;
  }

  function promoteProvisional(state) {
    if (!state) return [];
    state.segments = Array.isArray(state.segments) ? state.segments : [];
    const provisional = Array.isArray(state.provisional) ? state.provisional : [];
    const appended = [];
    for (const item of provisional) {
      const last = state.segments.at(-1);
      if (last && Number(item.end) <= Number(last.end) + 0.03) continue;
      const segment = { ...item, provisional: undefined };
      if (last && Number(segment.start) < Number(last.end)) segment.start = Number(last.end);
      segment.end = Math.max(Number(segment.start) + 0.05, Number(segment.end));
      state.segments.push(segment);
      appended.push(segment);
    }
    state.provisional = [];
    return appended;
  }

  return {
    applyTranscriptDelta,
    buildExport,
    cleanSegments,
    formatClock,
    promoteProvisional,
    safeFilename,
    subtitleTime
  };
});

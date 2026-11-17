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

  // YouTube-CC-like caption layout: short lines (about 26 characters for
  // Korean) and at most two lines on screen.
  const CAPTION_LINE_CHARS = 26;
  const CAPTION_MAX_LINES = 2;

  function greedyLines(words, limit) {
    const lines = [];
    let line = "";
    for (let word of words) {
      if (line && line.length + 1 + word.length <= limit) {
        line += ` ${word}`;
        continue;
      }
      if (line) lines.push(line);
      while (word.length > limit) {
        lines.push(word.slice(0, limit));
        word = word.slice(limit);
      }
      line = word;
    }
    if (line) lines.push(line);
    return lines;
  }

  // Wrap at word boundaries into as few lines as the limit allows, then
  // balance their lengths so a sentence does not end with a one-word orphan
  // ("…형사 책임을 묻지" / "않는데요.").
  function wrapCaption(text, lineChars = CAPTION_LINE_CHARS) {
    const limit = Math.max(4, Number(lineChars) || CAPTION_LINE_CHARS);
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = greedyLines(words, limit);
    if (lines.length < 2) return lines;
    const total = words.join(" ").length;
    for (let width = Math.ceil(total / lines.length); width < limit; width++) {
      const balanced = greedyLines(words, width);
      if (balanced.length === lines.length) return balanced;
    }
    return lines;
  }

  // Split each sentence into caption cues of at most two short lines, with
  // time divided by text length (for SRT/VTT).
  function captionCues(items, lineChars = CAPTION_LINE_CHARS, maxLines = CAPTION_MAX_LINES) {
    const cues = [];
    for (const item of items) {
      const lines = wrapCaption(item.text, lineChars);
      if (!lines.length) continue;
      const groups = [];
      for (let index = 0; index < lines.length; index += maxLines) {
        groups.push(lines.slice(index, index + maxLines));
      }
      const total = groups.reduce((sum, group) => sum + group.join("").length, 0) || 1;
      let start = Number(item.start);
      const duration = Math.max(0.05, Number(item.end) - start);
      groups.forEach((group, index) => {
        const end = index === groups.length - 1
          ? Number(item.end)
          : start + duration * (group.join("").length / total);
        cues.push({ start, end: Math.max(start + 0.05, end), text: group.join("\n") });
        start = end;
      });
    }
    return cues;
  }

  function buildExport(state, format) {
    const items = cleanSegments(state?.segments);
    const meta = state?.metadata || {};
    if (format === "txt") {
      const header = `# ${meta.title || "YouTube Live Transcript"}\n# ${meta.url || ""}\n# Started: ${state?.startedAt || ""}\n\n`;
      return {
        ext: "txt",
        mime: "text/plain;charset=utf-8",
        content: header + items.map(item => {
          const line = `[${formatClock(item.start)}] ${item.text}`;
          return item.original ? `${line}\n           (원문) ${item.original}` : line;
        }).join("\n")
      };
    }
    if (format === "srt") {
      return {
        ext: "srt",
        mime: "application/x-subrip;charset=utf-8",
        content: captionCues(items).map((item, index) => `${index + 1}\n${subtitleTime(item.start)} --> ${subtitleTime(item.end)}\n${item.text}\n`).join("\n")
      };
    }
    if (format === "vtt") {
      return {
        ext: "vtt",
        mime: "text/vtt;charset=utf-8",
        content: "WEBVTT\n\n" + captionCues(items).map(item => `${subtitleTime(item.start, ".")} --> ${subtitleTime(item.end, ".")}\n${item.text}\n`).join("\n")
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

  // The server sends the unfinished sentence as provisional items: words that
  // will not change (`stable: true`) first, then the still-changing tail.
  function currentSentence(provisional) {
    const items = (Array.isArray(provisional) ? provisional : [])
      .filter(item => String(item?.text || "").trim());
    if (!items.length) return null;
    const join = list => list.map(item => String(item.text).trim()).filter(Boolean).join(" ");
    const stableText = join(items.filter(item => item.stable));
    const unstableText = join(items.filter(item => !item.stable));
    return {
      id: items[0].id,
      sequence: items[0].sequence,
      start: Math.max(0, Number(items[0].start) || 0),
      end: Math.max(...items.map(item => Number(item.end) || 0)),
      text: [stableText, unstableText].filter(Boolean).join(" "),
      stableText,
      unstableText,
      original: items.map(item => String(item.original || "").trim()).filter(Boolean).join(" ")
    };
  }

  // Roll-up captions like YouTube CC: wrap the last finished sentence and
  // the sentence being spoken into short lines, and show only the newest
  // two lines. A new sentence always starts on a new line.
  function overlayText(segments, provisional, options = {}) {
    const lineChars = Number(options.lineChars) || CAPTION_LINE_CHARS;
    const maxLines = Number(options.maxLines) || CAPTION_MAX_LINES;
    const finals = (Array.isArray(segments) ? segments : [])
      .map(item => String(item?.text || "").trim())
      .filter(Boolean);
    const current = currentSentence(provisional)?.text || "";
    const lines = [
      ...wrapCaption(finals.at(-1) || "", lineChars),
      ...wrapCaption(current, lineChars)
    ];
    return lines.slice(-maxLines).join("\n");
  }

  function promoteProvisional(state) {
    if (!state) return [];
    state.segments = Array.isArray(state.segments) ? state.segments : [];
    const sentence = currentSentence(state.provisional);
    state.provisional = [];
    if (!sentence) return [];
    const last = state.segments.at(-1);
    if (last && sentence.end <= Number(last.end) + 0.03) return [];
    const segment = {
      id: sentence.id ? `${sentence.id}-final` : undefined,
      sequence: sentence.sequence,
      start: last && sentence.start < Number(last.end) ? Number(last.end) : sentence.start,
      end: sentence.end,
      text: sentence.text,
      ...(sentence.original ? { original: sentence.original } : {}),
      observedAt: new Date().toISOString()
    };
    segment.end = Math.max(segment.start + 0.05, segment.end);
    state.segments.push(segment);
    return [segment];
  }

  return {
    applyTranscriptDelta,
    buildExport,
    captionCues,
    cleanSegments,
    currentSentence,
    formatClock,
    overlayText,
    promoteProvisional,
    safeFilename,
    subtitleTime,
    wrapCaption
  };
});

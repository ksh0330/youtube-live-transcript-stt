from __future__ import annotations

import asyncio
import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterable


def normalize_text(text: str) -> str:
    return " ".join(str(text or "").replace("\u200b", "").split()).strip()


def comparison_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", normalize_text(text)).casefold()
    return "".join(char for char in normalized if char.isalnum())


MIN_LOOKBACK_MATCH = 5
LOOKBACK_CHARS = 12


def _comparison_prefix_cut(text: str, count: int) -> int:
    """Return the source index after `count` comparable characters."""
    seen = 0
    for index, char in enumerate(text):
        comparable = comparison_text(char)
        if comparable:
            seen += len(comparable)
            if seen >= count:
                return index + 1
    return len(text)


def overlap_cut(history: str, incoming: str, max_chars: int = 120) -> int:
    """Find a conservative suffix/prefix overlap and return an incoming cut index.

    Whitespace and punctuation are ignored for comparison so Korean spacing
    variations such as "고정 소수점" / "고정소수점" still match. Fuzzy matching
    is intentionally limited to timing-overlap callers and reasonably long text.
    """
    incoming = normalize_text(incoming)
    history_comp = comparison_text(history)[-max_chars:]
    incoming_comp = comparison_text(incoming)[:max_chars]
    limit = min(len(history_comp), len(incoming_comp))

    for size in range(limit, 3, -1):
        if history_comp[-size:] == incoming_comp[:size]:
            return _comparison_prefix_cut(incoming, size)

    # The next window may re-recognize the tail but drop or change a word at
    # the very end ("크기를 반드시" -> "크기를 확인해야"). Accept the incoming
    # prefix when it appears within the last few characters of history.
    for size in range(min(len(incoming_comp), max_chars), MIN_LOOKBACK_MATCH - 1, -1):
        if incoming_comp[:size] in history_comp[-(size + LOOKBACK_CHARS):]:
            return _comparison_prefix_cut(incoming, size)

    best_history_size = 0
    best_incoming_size = 0
    best_ratio = 0.0
    for history_size in range(min(len(history_comp), max_chars), 5, -1):
        incoming_min = max(6, history_size - 2)
        incoming_max = min(len(incoming_comp), history_size + 2)
        for incoming_size in range(incoming_max, incoming_min - 1, -1):
            ratio = SequenceMatcher(
                None,
                history_comp[-history_size:],
                incoming_comp[:incoming_size],
                autojunk=False,
            ).ratio()
            comparable_size = min(history_size, incoming_size)
            threshold = 0.9 if comparable_size < 10 else 0.8
            if (
                ratio >= threshold
                and ratio * comparable_size
                > best_ratio * min(best_history_size, best_incoming_size)
            ):
                best_history_size = history_size
                best_incoming_size = incoming_size
                best_ratio = ratio

    return (
        _comparison_prefix_cut(incoming, best_incoming_size)
        if best_incoming_size
        else 0
    )


def remove_overlap(history: str, incoming: str) -> str:
    incoming = normalize_text(incoming)
    if not incoming:
        return ""
    cut = overlap_cut(history, incoming)
    return normalize_text(incoming[cut:]) if cut else incoming


def merge_overlapping_text(history: str, incoming: str) -> str:
    history = normalize_text(history)
    unique = remove_overlap(history, incoming)
    if not history:
        return unique
    if not unique:
        return history
    spacer = "" if re.match(r"^[,.!?;:)]", unique) else " "
    return normalize_text(f"{history}{spacer}{unique}")


MIN_CONTAINED_CHARS = 4


def is_contained(inner: str, outer: str) -> bool:
    """True when `inner` appears inside `outer`, ignoring spacing/punctuation."""
    inner_comp = comparison_text(inner)
    return len(inner_comp) >= MIN_CONTAINED_CHARS and inner_comp in comparison_text(outer)


def texts_overlap(first: str, second: str) -> bool:
    """True when two recognitions of nearby audio share text in any direction."""
    return bool(
        overlap_cut(first, second)
        or overlap_cut(second, first)
        or is_contained(first, second)
        or is_contained(second, first)
    )


def merge_reprediction(previous: str, incoming: str) -> str:
    """Combine two recognitions of the same audio without repeating text."""
    if is_contained(incoming, previous):
        return normalize_text(previous)
    if is_contained(previous, incoming):
        return normalize_text(incoming)
    return merge_overlapping_text(previous, incoming)


MAX_REPEATED_TOKENS = 8
MIN_REPEAT_COUNT = 3


def _collapse_token_repeats(text: str) -> str:
    tokens = text.split()
    changed = True
    while changed:
        changed = False
        for size in range(1, min(MAX_REPEATED_TOKENS, len(tokens) // MIN_REPEAT_COUNT) + 1):
            index = 0
            while index + size * MIN_REPEAT_COUNT <= len(tokens):
                unit = comparison_text(" ".join(tokens[index:index + size]))
                if not unit:
                    index += 1
                    continue
                repeats = 1
                while (
                    index + size * (repeats + 1) <= len(tokens)
                    and comparison_text(
                        " ".join(tokens[index + size * repeats:index + size * (repeats + 1)])
                    ) == unit
                ):
                    repeats += 1
                if repeats >= MIN_REPEAT_COUNT:
                    del tokens[index + size:index + size * repeats]
                    changed = True
                index += 1
    return " ".join(tokens)


_CHAR_REPEAT = re.compile(r"(\S.{3,40}?)\1{2,}")


def _collapse_char_repeat(match: re.Match[str]) -> str:
    unit = match.group(1)
    # Keep numbers such as 1000000 intact; only collapse repeated words.
    return unit if any(char.isalpha() for char in unit) else match.group(0)


def collapse_repetitions(text: str) -> str:
    """Remove Whisper repetition loops (the same phrase 3+ times in a row).

    A phrase spoken twice is kept; three or more consecutive copies inside a
    single segment are almost always a decoding loop on music or silence.
    """
    text = normalize_text(text)
    if not text:
        return ""
    text = _collapse_token_repeats(text)
    return normalize_text(_CHAR_REPEAT.sub(_collapse_char_repeat, text))


@dataclass(frozen=True)
class TranscriptSegment:
    start: float
    end: float
    text: str

    def cleaned(self) -> "TranscriptSegment | None":
        text = normalize_text(self.text)
        start = max(0.0, float(self.start))
        end = max(start + 0.05, float(self.end))
        return TranscriptSegment(start, end, text) if text else None

    def as_dict(self) -> dict[str, float | str]:
        return {
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "text": self.text,
        }


def map_model_segments(
    segments: Iterable[object], window_start: float
) -> list[TranscriptSegment]:
    mapped: list[TranscriptSegment] = []
    for segment in segments:
        text = collapse_repetitions(getattr(segment, "text", ""))
        if not text:
            continue
        start = window_start + max(0.0, float(getattr(segment, "start", 0.0)))
        end = window_start + max(0.0, float(getattr(segment, "end", start)))
        cleaned = TranscriptSegment(start, end, text).cleaned()
        if cleaned:
            mapped.append(cleaned)
    return collapse_repeated_segments(
        sorted(mapped, key=lambda item: (item.start, item.end))
    )


def collapse_repeated_segments(
    segments: list[TranscriptSegment],
) -> list[TranscriptSegment]:
    """Merge 3+ consecutive segments with identical text from one window."""
    result: list[TranscriptSegment] = []
    index = 0
    while index < len(segments):
        run_end = index + 1
        key = comparison_text(segments[index].text)
        while (
            key
            and run_end < len(segments)
            and comparison_text(segments[run_end].text) == key
        ):
            run_end += 1
        if run_end - index >= MIN_REPEAT_COUNT:
            first = segments[index]
            result.append(
                TranscriptSegment(first.start, segments[run_end - 1].end, first.text)
            )
        else:
            result.extend(segments[index:run_end])
        index = run_end
    return result


class TranscriptStabilizer:
    """Keep a short revisable tail and emit only segments behind a time horizon."""

    def __init__(
        self,
        commit_horizon_seconds: float = 2.0,
        reprediction_tolerance_seconds: float = 1.0,
    ) -> None:
        self.commit_horizon_seconds = max(0.5, float(commit_horizon_seconds))
        # Whisper timestamps for the same words can move by up to about a
        # second between overlapping windows, so a re-recognition of the
        # previous provisional tail is matched with this time tolerance.
        self.reprediction_tolerance_seconds = max(
            0.25, float(reprediction_tolerance_seconds)
        )
        self.final_end = 0.0
        self._final_context = ""
        self._previous_provisional: list[TranscriptSegment] = []

    def _append_final(
        self, segment: TranscriptSegment, output: list[TranscriptSegment]
    ) -> None:
        if segment.end <= self.final_end + 0.05:
            return

        timing_overlaps = segment.start <= self.final_end + 0.1
        text = (
            remove_overlap(self._final_context[-500:], segment.text)
            if timing_overlaps
            else normalize_text(segment.text)
        )
        if not text:
            self.final_end = max(self.final_end, segment.end)
            return

        start = max(self.final_end, segment.start)
        end = max(start + 0.05, segment.end)
        accepted = TranscriptSegment(start, end, text)
        output.append(accepted)
        self.final_end = accepted.end
        self._final_context = normalize_text(
            f"{self._final_context} {accepted.text}"
        )[-1200:]

    def update(
        self,
        current: Iterable[TranscriptSegment],
        *,
        window_start: float,
        audio_end: float,
    ) -> tuple[list[TranscriptSegment], list[TranscriptSegment]]:
        cleaned = [item.cleaned() for item in current]
        current_segments = sorted(
            (item for item in cleaned if item is not None),
            key=lambda item: (item.start, item.end),
        )
        horizon = max(0.0, float(audio_end) - self.commit_horizon_seconds)

        tolerance = self.reprediction_tolerance_seconds

        def near(first: TranscriptSegment, second: TranscriptSegment) -> bool:
            return (
                first.start <= second.end + tolerance
                and first.end >= second.start - tolerance
            )

        raw_final_candidates = [item for item in current_segments if item.end <= horizon]
        final_candidates: list[TranscriptSegment] = []
        for candidate in raw_final_candidates:
            overlapping_previous = [
                item
                for item in self._previous_provisional
                if near(item, candidate)
                and item.end > self.final_end + 0.05
                and texts_overlap(item.text, candidate.text)
            ]
            if overlapping_previous:
                previous = max(
                    overlapping_previous,
                    key=lambda item: min(item.end, candidate.end)
                    - max(item.start, candidate.start),
                )
                candidate = TranscriptSegment(
                    min(previous.start, candidate.start),
                    max(previous.end, candidate.end),
                    merge_reprediction(previous.text, candidate.text),
                )
            final_candidates.append(candidate)

        # A long Whisper segment can begin before the next rolling window. Keep
        # the previous result as a fallback so that old audio is never lost.
        covered_start = min(
            (item.start for item in final_candidates), default=float("inf")
        )
        fallback = [
            item
            for item in self._previous_provisional
            if item.end <= horizon
            and item.end > self.final_end + 0.05
            and item.start < covered_start
            and item.start <= window_start + 0.25
            and not any(
                near(candidate, item) and texts_overlap(item.text, candidate.text)
                for candidate in final_candidates
            )
        ]

        newly_finalized: list[TranscriptSegment] = []
        for item in sorted(fallback + final_candidates, key=lambda x: (x.start, x.end)):
            self._append_final(item, newly_finalized)

        provisional: list[TranscriptSegment] = []
        provisional_context = self._final_context
        provisional_end = self.final_end
        for item in current_segments:
            if item.end <= horizon or item.end <= self.final_end + 0.05:
                continue
            timing_overlaps = item.start <= provisional_end + 0.1
            text = (
                remove_overlap(provisional_context[-500:], item.text)
                if timing_overlaps
                else normalize_text(item.text)
            )
            if not text:
                provisional_end = max(provisional_end, item.end)
                continue
            start = max(self.final_end, item.start)
            accepted = TranscriptSegment(start, max(start + 0.05, item.end), text)
            provisional.append(accepted)
            provisional_context = normalize_text(
                f"{provisional_context} {accepted.text}"
            )[-1200:]
            provisional_end = accepted.end

        self._previous_provisional = provisional
        return newly_finalized, provisional

    def flush(self) -> list[TranscriptSegment]:
        finalized: list[TranscriptSegment] = []
        for item in self._previous_provisional:
            self._append_final(item, finalized)
        self._previous_provisional = []
        return finalized


class BoundedAudioBuffer:
    """PCM16 buffer that drops the oldest unprocessed audio on overload."""

    def __init__(self, sample_rate: int, max_seconds: float) -> None:
        self.sample_rate = int(sample_rate)
        self.bytes_per_sample = 2
        self.max_bytes = max(
            self.bytes_per_sample,
            int(self.sample_rate * self.bytes_per_sample * float(max_seconds)),
        )
        self.max_bytes -= self.max_bytes % self.bytes_per_sample
        self._data = bytearray()
        self._start_sample = 0
        self.total_received_samples = 0
        self.dropped_samples = 0
        self.closed = False
        self._changed = asyncio.Event()

    @property
    def seconds(self) -> float:
        return len(self._data) / self.bytes_per_sample / self.sample_rate

    @property
    def dropped_seconds(self) -> float:
        return self.dropped_samples / self.sample_rate

    def append(self, raw: bytes) -> None:
        if self.closed or not raw:
            return
        usable = len(raw) - (len(raw) % self.bytes_per_sample)
        if usable <= 0:
            return
        self._data.extend(raw[:usable])
        self.total_received_samples += usable // self.bytes_per_sample
        overflow = len(self._data) - self.max_bytes
        if overflow > 0:
            overflow -= overflow % self.bytes_per_sample
            del self._data[:overflow]
            dropped = overflow // self.bytes_per_sample
            self._start_sample += dropped
            self.dropped_samples += dropped
        self._changed.set()

    def close(self) -> None:
        self.closed = True
        self._changed.set()

    def keep_latest(self, seconds: float) -> None:
        keep_bytes = int(self.sample_rate * self.bytes_per_sample * max(0.0, seconds))
        keep_bytes -= keep_bytes % self.bytes_per_sample
        discard = max(0, len(self._data) - keep_bytes)
        discard -= discard % self.bytes_per_sample
        if discard:
            del self._data[:discard]
            dropped = discard // self.bytes_per_sample
            self._start_sample += dropped
            self.dropped_samples += dropped

    async def pop(self, byte_count: int) -> tuple[bytes, int] | None:
        byte_count = max(self.bytes_per_sample, int(byte_count))
        byte_count -= byte_count % self.bytes_per_sample
        while len(self._data) < byte_count and not self.closed:
            self._changed.clear()
            if len(self._data) >= byte_count or self.closed:
                break
            await self._changed.wait()

        if len(self._data) < byte_count:
            return None
        return self._take(byte_count)

    def pop_remaining(self, minimum_bytes: int = 0) -> tuple[bytes, int] | None:
        usable = len(self._data) - (len(self._data) % self.bytes_per_sample)
        if usable < minimum_bytes or usable <= 0:
            return None
        return self._take(usable)

    def _take(self, byte_count: int) -> tuple[bytes, int]:
        start_sample = self._start_sample
        raw = bytes(self._data[:byte_count])
        del self._data[:byte_count]
        self._start_sample += byte_count // self.bytes_per_sample
        return raw, start_sample

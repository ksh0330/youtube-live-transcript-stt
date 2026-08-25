from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import sys
import time
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

PROJECT_DIR = Path(__file__).resolve().parents[1]
SERVER_DIR = PROJECT_DIR / "local-stt-server"
sys.path.insert(0, str(SERVER_DIR))

from streaming import TranscriptStabilizer, comparison_text, map_model_segments  # noqa: E402

REFERENCE = """
오늘은 고정 소수점 수 체계를 설명하겠습니다.
삼십이 비트 안에서 정수부와 소수부를 함께 표현할 수 있습니다.
스케일링 팩터를 사용하면 여덟 번째 비트 위치를 소수점처럼 해석합니다.
씨 언어의 인트와 롱 자료형, 씨 팔십구와 씨 구십구 표준도 비교하겠습니다.
엑스 팔십육과 엑스 육십사 환경에서는 자료형 크기를 반드시 확인해야 합니다.
픽스드 포인트와 플로팅 포인트는 정확도와 표현 범위에서 서로 다른 장단점이 있습니다.
이제 같은 핵심 문장을 실제 반복으로 다시 설명하겠습니다.
삼십이 비트 안에서 정수부와 소수부를 함께 표현할 수 있습니다.
"""

CONFIGS = [(5.0, 1.0), (3.0, 1.5), (4.0, 2.0), (5.0, 2.0)]
SAMPLE_RATE = 16000


def edit_distance(left: str, right: str) -> int:
    if len(left) > len(right):
        left, right = right, left
    previous = list(range(len(left) + 1))
    for right_index, right_char in enumerate(right, 1):
        current = [right_index]
        for left_index, left_char in enumerate(left, 1):
            current.append(min(
                current[-1] + 1,
                previous[left_index] + 1,
                previous[left_index - 1] + (left_char != right_char),
            ))
        previous = current
    return previous[-1]


def rss_megabytes() -> float | None:
    if os.name != "nt":
        try:
            import resource

            return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        except Exception:
            return None

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_ulong),
            ("PageFaultCount", ctypes.c_ulong),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    ctypes.windll.kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_ulong,
    ]
    counters = ProcessMemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    handle = ctypes.windll.kernel32.GetCurrentProcess()
    if not ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
        return None
    return counters.WorkingSetSize / 1024 / 1024


def percentile(values: list[float], percentile_value: float) -> float:
    if not values:
        return 0.0
    return float(np.percentile(np.asarray(values), percentile_value))


def run_config(
    model: WhisperModel,
    audio: np.ndarray,
    chunk_seconds: float,
    overlap_seconds: float,
    word_timestamps: bool = False,
) -> dict[str, object]:
    duration = len(audio) / SAMPLE_RATE
    offset = 0.0
    stabilizer = TranscriptStabilizer(commit_horizon_seconds=min(2.0, overlap_seconds))
    finalized = []
    inference_times = []
    backlog = 0.0
    max_backlog = 0.0
    wall_start = time.perf_counter()
    cpu_start = time.process_time()

    while offset < duration:
        audio_end = min(duration, offset + chunk_seconds)
        window_start = max(0.0, offset - overlap_seconds)
        window = audio[int(window_start * SAMPLE_RATE):int(audio_end * SAMPLE_RATE)]
        started = time.perf_counter()
        segments, _info = model.transcribe(
            window,
            language="ko",
            beam_size=1,
            vad_filter=True,
            vad_parameters={
                "threshold": 0.5,
                "min_speech_duration_ms": 250,
                "min_silence_duration_ms": 500,
                "speech_pad_ms": 300,
            },
            condition_on_previous_text=False,
            initial_prompt=None,
            temperature=0.0,
            word_timestamps=word_timestamps,
            hallucination_silence_threshold=2.0,
        )
        mapped = map_model_segments(list(segments), window_start)
        elapsed = time.perf_counter() - started
        inference_times.append(elapsed)
        # Live capture supplies one full new-audio interval between windows.
        # Treat the final partial fixture window as a stop flush, not backlog.
        backlog = max(0.0, backlog + elapsed - chunk_seconds)
        max_backlog = max(max_backlog, backlog)
        new_final, _provisional = stabilizer.update(
            mapped, window_start=window_start, audio_end=audio_end
        )
        finalized.extend(new_final)
        offset = audio_end

    finalized.extend(stabilizer.flush())
    wall_seconds = time.perf_counter() - wall_start
    cpu_seconds = time.process_time() - cpu_start
    transcript = " ".join(item.text for item in finalized)
    reference_comp = comparison_text(REFERENCE)
    transcript_comp = comparison_text(transcript)
    cer = edit_distance(reference_comp, transcript_comp) / max(1, len(reference_comp))
    duplicate_excess = max(0, len(transcript_comp) - len(reference_comp)) / max(1, len(transcript_comp))
    boundary_fragments = sum(
        1
        for item in finalized[:-1]
        if not re.search(r"(?:[.!?]|합니다|됩니다|있습니다|입니다|겠습니다)$", item.text)
    )
    return {
        "chunk_seconds": chunk_seconds,
        "overlap_seconds": overlap_seconds,
        "word_timestamps": word_timestamps,
        "audio_duration_seconds": round(duration, 3),
        "windows": len(inference_times),
        "mean_inference_seconds": round(float(np.mean(inference_times)), 3),
        "p95_inference_seconds": round(percentile(inference_times, 95), 3),
        "max_estimated_backlog_seconds": round(max_backlog, 3),
        "wall_seconds": round(wall_seconds, 3),
        "process_cpu_percent": round(cpu_seconds / max(wall_seconds, 0.001) * 100, 1),
        "rss_megabytes": round(rss_megabytes() or 0.0, 1),
        "character_error_rate": round(cer, 4),
        "duplicate_excess_rate": round(duplicate_excess, 4),
        "boundary_fragment_count": boundary_fragments,
        "final_segments": len(finalized),
        "transcript": transcript,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark rolling faster-whisper configurations.")
    parser.add_argument("audio", type=Path)
    parser.add_argument("--model-size", default="small")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--include-word-timestamps", action="store_true")
    args = parser.parse_args()

    audio = decode_audio(str(args.audio), sampling_rate=SAMPLE_RATE)
    model = WhisperModel(args.model_size, device="cpu", compute_type="int8")
    results = [run_config(model, audio, chunk, overlap) for chunk, overlap in CONFIGS]
    if args.include_word_timestamps:
        results.append(run_config(model, audio, 4.0, 2.0, word_timestamps=True))
    payload = {
        "audio": str(args.audio.resolve()),
        "model_size": args.model_size,
        "device": "cpu",
        "compute_type": "int8",
        "results": results,
    }
    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()

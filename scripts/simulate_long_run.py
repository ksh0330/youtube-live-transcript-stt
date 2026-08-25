from __future__ import annotations

import asyncio
import json
import sys
import tracemalloc
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "local-stt-server"))

from streaming import BoundedAudioBuffer  # noqa: E402

SAMPLE_RATE = 16000
PACKET_SECONDS = 0.1
CHUNK_SECONDS = 4.0
QUEUE_SECONDS = 16.0
INFERENCE_SECONDS = 5.2  # Deliberately slower than real time to exercise overload.


async def simulate(duration_seconds: int) -> dict[str, float | int]:
    packet_bytes = int(SAMPLE_RATE * 2 * PACKET_SECONDS)
    chunk_bytes = int(SAMPLE_RATE * 2 * CHUNK_SECONDS)
    buffer = BoundedAudioBuffer(SAMPLE_RATE, QUEUE_SECONDS)
    capture_time = 0.0
    worker_available = 0.0
    segment_count = 0
    max_queue = 0.0
    transcript = []
    baseline_storage_bytes = 0
    checkpoint_storage_bytes = 0
    next_checkpoint = 8.0

    while capture_time < duration_seconds:
        buffer.append(bytes(packet_bytes))
        capture_time += PACKET_SECONDS
        if capture_time >= worker_available and buffer.seconds >= CHUNK_SECONDS:
            item = await buffer.pop(chunk_bytes)
            if item:
                _raw, start_sample = item
                segment_count += 1
                transcript.append({
                    "start": start_sample / SAMPLE_RATE,
                    "end": start_sample / SAMPLE_RATE + CHUNK_SECONDS,
                    "text": f"합성 장시간 세그먼트 {segment_count}",
                })
                serialized_size = len(json.dumps(transcript, ensure_ascii=False).encode("utf-8"))
                baseline_storage_bytes += serialized_size
                if capture_time >= next_checkpoint:
                    checkpoint_storage_bytes += serialized_size
                    next_checkpoint += 8.0
                worker_available = capture_time + INFERENCE_SECONDS
        max_queue = max(max_queue, buffer.seconds)

    final_size = len(json.dumps(transcript, ensure_ascii=False).encode("utf-8"))
    checkpoint_storage_bytes += final_size
    current, peak = tracemalloc.get_traced_memory()
    return {
        "duration_seconds": duration_seconds,
        "segments": segment_count,
        "max_queue_seconds": round(max_queue, 2),
        "dropped_seconds": round(buffer.dropped_seconds, 2),
        "final_transcript_json_megabytes": round(final_size / 1024 / 1024, 3),
        "baseline_storage_write_megabytes": round(baseline_storage_bytes / 1024 / 1024, 2),
        "checkpoint_storage_write_megabytes": round(checkpoint_storage_bytes / 1024 / 1024, 2),
        "rendered_dom_items": min(segment_count, 500),
        "python_traced_current_megabytes": round(current / 1024 / 1024, 3),
        "python_traced_peak_megabytes": round(peak / 1024 / 1024, 3),
    }


async def main() -> None:
    tracemalloc.start()
    results = [await simulate(seconds) for seconds in (1800, 3600, 10800)]
    print(json.dumps({
        "scenario": "4s chunks, simulated 5.2s inference, bounded 16s oldest-drop queue",
        "results": results,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())

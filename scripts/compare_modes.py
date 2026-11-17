"""Stream a WAV clip through the real server code and compare streaming settings.

Audio is sent in lock-step (one chunk, then wait for its update), so slow
settings are measured without dropping audio. Each setting is
size:device:compute:mode, for example:

    python scripts/compare_modes.py benchmark-results/lecture-fixture.wav \
        small:cpu:int8:rolling large-v3-turbo:cuda:float16:sentence

    python scripts/compare_modes.py benchmark-results/english-fixture.wav \
        large-v3-turbo:cuda:float16:sentence --language auto --translate-to ko

If a .txt file with the same name sits next to the WAV (generate_fixture.ps1
writes one), the character error rate against it is printed too. CER of a
translated run is computed on the original text.
"""
from __future__ import annotations

import argparse
import gc
import sys
import time
import wave
from pathlib import Path

import numpy as np

SERVER_DIR = Path(__file__).resolve().parents[1] / "local-stt-server"
sys.path.insert(0, str(SERVER_DIR))

import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402
from streaming import comparison_text  # noqa: E402

SAMPLE_RATE = 16000


def load_pcm(path: Path) -> bytes:
    with wave.open(str(path)) as source:
        rate = source.getframerate()
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2")
    audio = samples.astype(np.float32) / 32768.0
    target = int(len(audio) * SAMPLE_RATE / rate)
    audio = np.interp(np.linspace(0, len(audio) - 1, target), np.arange(len(audio)), audio)
    return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()


def edit_distance(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, char_a in enumerate(a, 1):
        current = [i]
        for j, char_b in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (char_a != char_b)))
        previous = current
    return previous[-1]


def run(pcm: bytes, spec: str, language: str, translate_to: str, reference: str | None) -> None:
    size, device, compute, mode = spec.split(":")
    server.CONFIG.update({"model_size": size, "streaming_mode": mode, "queue_max_seconds": 120.0})
    server.MODEL = WhisperModel(size, device=device, compute_type=compute)
    server.DEVICE_RESOLVED, server.COMPUTE_RESOLVED = device, compute
    server.TRANSLATOR = None  # load it again so it runs on this setting's device
    if translate_to:
        server.preload_translator()

    chunk = float(server.CONFIG.get("sentence_chunk_seconds", 2.0)) if mode == "sentence" else float(
        server.CONFIG.get("chunk_seconds", 4.0)
    )
    step = int(SAMPLE_RATE * 2 * chunk)
    finals, lags, inference, detected = [], [], [], set()
    update_seconds = []

    with TestClient(server.app).websocket_connect("/ws/transcribe") as websocket:
        websocket.receive_json()
        websocket.receive_json()
        websocket.send_json({"type": "config", "language": language, "translate_to": translate_to})
        for offset in range(0, len(pcm) - step + 1, step):
            websocket.send_bytes(pcm[offset:offset + step])
            started = time.perf_counter()
            message = websocket.receive_json()
            update_seconds.append(time.perf_counter() - started)
            inference.append(message["inference_ms"])
            detected.add(message.get("language"))
            for item in message["finalized"]:
                finals.append(item)
                lags.append(message["audio_end"] - item["end"])
        websocket.send_bytes(pcm[(len(pcm) // step) * step:])
        websocket.send_json({"type": "stop"})
        while True:
            message = websocket.receive_json()
            if message.get("type") == "stop_ack":
                break
            finals += message.get("finalized", [])

    line = (
        f"== {size} / {device} / {mode}: sentences {len(finals)}, "
        f"avg inference {np.mean(inference):.0f} ms, update {np.mean(update_seconds):.2f} s "
        f"(max {np.max(update_seconds):.2f} s) per {chunk:g} s of audio, "
        f"time to commit {np.mean(lags):.1f} s (max {np.max(lags):.1f} s), language {sorted(map(str, detected))}"
    )
    if reference:
        spoken = " ".join(item.get("original") or item["text"] for item in finals)
        expected = comparison_text(reference)
        line += f", CER {edit_distance(comparison_text(spoken), expected) / len(expected):.3f}"
    print(line)
    for item in finals:
        original = f"   (original: {item['original']})" if item.get("original") else ""
        print(f"   | {item['text']}{original}")

    server.MODEL = None
    gc.collect()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("audio", type=Path)
    parser.add_argument("settings", nargs="+", help="size:device:compute:mode")
    parser.add_argument("--language", default="ko", help="ko, en, ja, zh, or auto")
    parser.add_argument("--translate-to", default="", help="ko to translate other languages into Korean")
    args = parser.parse_args()

    reference_path = args.audio.with_suffix(".txt")
    reference = reference_path.read_text(encoding="utf-8") if reference_path.exists() else None
    pcm = load_pcm(args.audio)
    base_config = dict(server.CONFIG)
    for spec in args.settings:
        server.CONFIG.clear()
        server.CONFIG.update(base_config)
        run(pcm, spec, args.language, args.translate_to, reference)


if __name__ == "__main__":
    main()

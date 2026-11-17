from __future__ import annotations

import argparse
import asyncio
import json
import wave
from pathlib import Path

import numpy as np
import websockets

SAMPLE_RATE = 16000


def decode_audio(path: str, sampling_rate: int) -> np.ndarray:
    """Read a 16-bit WAV directly; other formats go through faster-whisper (PyAV)."""
    if not path.lower().endswith(".wav"):
        from faster_whisper.audio import decode_audio as decode_with_av

        return decode_with_av(path, sampling_rate=sampling_rate)
    with wave.open(path) as source:
        rate, channels = source.getframerate(), source.getnchannels()
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2")
    audio = samples.astype(np.float32).reshape(-1, channels).mean(axis=1) / 32768.0
    target = int(len(audio) * sampling_rate / rate)
    return np.interp(np.linspace(0, len(audio) - 1, target), np.arange(len(audio)), audio).astype(np.float32)


async def run(
    audio_path: Path, duration: float, realtime_factor: float, language: str, translate_to: str
) -> None:
    audio = decode_audio(str(audio_path), sampling_rate=SAMPLE_RATE)
    audio = audio[: int(duration * SAMPLE_RATE)]
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    packet_bytes = int(SAMPLE_RATE * 2 * 0.1)
    updates = []
    statuses = []

    async with websockets.connect(
        "ws://127.0.0.1:8765/ws/transcribe", max_size=2**20
    ) as websocket:
        async def receive() -> None:
            while True:
                message = json.loads(await websocket.recv())
                if message.get("type") == "error":
                    raise RuntimeError(message.get("message") or "server error")
                if message.get("type") == "status":
                    statuses.append(message.get("status"))
                if message.get("type") == "transcript_update":
                    updates.append(message)
                if message.get("type") == "stop_ack":
                    return

        receiver = asyncio.create_task(receive())
        await websocket.send(json.dumps({
            "type": "config", "language": language, "translate_to": translate_to,
        }))
        for offset in range(0, len(pcm), packet_bytes):
            await websocket.send(pcm[offset:offset + packet_bytes])
            await asyncio.sleep(0.1 / max(0.1, realtime_factor))
        await websocket.send(json.dumps({"type": "stop"}))
        await asyncio.wait_for(receiver, timeout=15)

    finalized = [
        segment
        for update in updates
        for segment in update.get("finalized", [])
    ]
    if not finalized:
        raise RuntimeError("No finalized transcript was returned")
    last = updates[-1]
    print(json.dumps({
        "statuses": statuses,
        "updates": len(updates),
        "finalized_segments": len(finalized),
        "last_queue_seconds": last.get("queue_seconds"),
        "dropped_seconds": last.get("dropped_seconds"),
        "last_sequence": last.get("sequence"),
        # The flush sent on stop carries only text, so read these from the last regular update.
        "mode": next((u["mode"] for u in reversed(updates) if u.get("mode")), None),
        "language": next((u["language"] for u in reversed(updates) if u.get("language")), None),
        "text": " ".join(item["text"] for item in finalized),
        "original": " ".join(item.get("original") or item["text"] for item in finalized),
    }, ensure_ascii=False, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Stream a fixture through the real local WebSocket server.")
    parser.add_argument("audio", type=Path)
    parser.add_argument("--duration", type=float, default=12.0)
    parser.add_argument("--realtime-factor", type=float, default=1.0)
    parser.add_argument("--language", default="ko", help="ko, en, ja, zh, or auto")
    parser.add_argument("--translate-to", default="", help="ko to translate other languages into Korean")
    args = parser.parse_args()
    asyncio.run(run(args.audio, args.duration, args.realtime_factor, args.language, args.translate_to))


if __name__ == "__main__":
    main()

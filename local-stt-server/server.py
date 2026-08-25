from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from faster_whisper import WhisperModel

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "server_config.json"
SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)
log = logging.getLogger("yt-live-stt")

with CONFIG_PATH.open("r", encoding="utf-8") as f:
    CONFIG: dict[str, Any] = json.load(f)

MODEL: WhisperModel | None = None
MODEL_LOCK = asyncio.Lock()
DEVICE_RESOLVED = "unloaded"
COMPUTE_RESOLVED = "unloaded"


def _resolve_device() -> tuple[str, str]:
    requested_device = str(CONFIG.get("device", "auto")).lower()
    requested_compute = str(CONFIG.get("compute_type", "auto")).lower()

    if requested_device != "auto":
        if requested_compute != "auto":
            return requested_device, requested_compute
        return requested_device, "float16" if requested_device == "cuda" else "int8"

    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def _probe_model_inference(model: WhisperModel) -> None:
    """Force one tiny inference pass.

    CTranslate2 can construct a CUDA model successfully even when CUDA runtime
    DLLs (for example cublas64_12.dll/cudnn64_9.dll) are missing. Those errors
    are often raised only when the first encoder inference actually runs.
    """
    probe = np.zeros(SAMPLE_RATE, dtype=np.float32)
    segments, _info = model.transcribe(
        probe,
        language=str(CONFIG.get("language", "ko")) or None,
        beam_size=1,
        vad_filter=False,
        condition_on_previous_text=False,
        temperature=0.0,
        word_timestamps=False,
    )
    # faster-whisper returns a lazy generator; consuming it triggers inference.
    list(segments)


def _load_model_sync() -> WhisperModel:
    global DEVICE_RESOLVED, COMPUTE_RESOLVED

    model_size = str(CONFIG.get("model_size", "small"))
    device, compute = _resolve_device()
    log.info("Whisper model loading: model=%s device=%s compute=%s", model_size, device, compute)

    if device == "cuda":
        try:
            gpu_model = WhisperModel(model_size, device="cuda", compute_type=compute)
            log.info("CUDA model constructed; running real inference preflight...")
            _probe_model_inference(gpu_model)
            DEVICE_RESOLVED, COMPUTE_RESOLVED = "cuda", compute
            log.info("CUDA inference preflight passed.")
            return gpu_model
        except Exception as cuda_error:
            log.warning(
                "CUDA inference unavailable (%s). Falling back automatically to CPU int8.",
                cuda_error,
            )

    cpu_model = WhisperModel(model_size, device="cpu", compute_type="int8")
    log.info("CPU model constructed; running inference preflight...")
    _probe_model_inference(cpu_model)
    DEVICE_RESOLVED, COMPUTE_RESOLVED = "cpu", "int8"
    log.info("CPU inference preflight passed.")
    return cpu_model


async def get_model() -> WhisperModel:
    global MODEL
    if MODEL is not None:
        return MODEL
    async with MODEL_LOCK:
        if MODEL is None:
            MODEL = await asyncio.to_thread(_load_model_sync)
    return MODEL


def pcm16_to_float32(raw: bytes) -> np.ndarray:
    if not raw:
        return np.zeros((0,), dtype=np.float32)
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32)
    return samples / 32768.0


def normalize_text(text: str) -> str:
    return " ".join(str(text or "").replace("\u200b", "").split()).strip()


def longest_token_overlap(history: str, incoming: str, max_tokens: int = 14) -> int:
    h = normalize_text(history).split()
    n = normalize_text(incoming).split()
    limit = min(max_tokens, len(h), len(n))
    for size in range(limit, 0, -1):
        if h[-size:] == n[:size]:
            return size
    return 0


def longest_char_overlap(history: str, incoming: str, max_chars: int = 80) -> int:
    h = normalize_text(history)
    n = normalize_text(incoming)
    limit = min(max_chars, len(h), len(n))
    for size in range(limit, 3, -1):
        if h[-size:] == n[:size]:
            return size
    return 0


def dedupe_overlap(history: str, incoming: str) -> str:
    incoming = normalize_text(incoming)
    if not incoming:
        return ""

    token_overlap = longest_token_overlap(history, incoming)
    if token_overlap:
        tokens = incoming.split()
        return normalize_text(" ".join(tokens[token_overlap:]))

    char_overlap = longest_char_overlap(history, incoming)
    if char_overlap:
        return normalize_text(incoming[char_overlap:])

    return incoming


def transcribe_sync(model: WhisperModel, audio: np.ndarray, language: str) -> str:
    if audio.size == 0:
        return ""

    segments, _info = model.transcribe(
        audio,
        language=language or None,
        beam_size=int(CONFIG.get("beam_size", 1)),
        vad_filter=bool(CONFIG.get("vad_filter", True)),
        vad_parameters={"min_silence_duration_ms": 300},
        condition_on_previous_text=False,
        temperature=0.0,
        word_timestamps=False,
    )
    return normalize_text(" ".join(seg.text.strip() for seg in segments if seg.text.strip()))


app = FastAPI(title="YouTube Live Local STT", version="0.2.0")


@app.get("/health")
async def health() -> dict[str, Any]:
    requested_device = str(CONFIG.get("device", "auto"))
    return {
        "ok": True,
        "model_size": CONFIG.get("model_size", "small"),
        "language": CONFIG.get("language", "ko"),
        "device": requested_device,
        "device_resolved": DEVICE_RESOLVED,
        "compute_type": COMPUTE_RESOLVED,
        "model_loaded": MODEL is not None,
        "automatic_cpu_fallback": True,
        "chunk_seconds": CONFIG.get("chunk_seconds", 5.0),
        "overlap_seconds": CONFIG.get("overlap_seconds", 1.0),
    }


@app.post("/warmup")
async def warmup() -> dict[str, Any]:
    await get_model()
    return {
        "ok": True,
        "model_loaded": True,
        "model_size": CONFIG.get("model_size", "small"),
        "device_resolved": DEVICE_RESOLVED,
        "compute_type": COMPUTE_RESOLVED,
    }


@app.websocket("/ws/transcribe")
async def websocket_transcribe(websocket: WebSocket) -> None:
    await websocket.accept()

    language = str(CONFIG.get("language", "ko"))
    chunk_seconds = float(CONFIG.get("chunk_seconds", 5.0))
    overlap_seconds = float(CONFIG.get("overlap_seconds", 1.0))
    chunk_bytes = int(SAMPLE_RATE * BYTES_PER_SAMPLE * chunk_seconds)
    overlap_bytes = int(SAMPLE_RATE * BYTES_PER_SAMPLE * overlap_seconds)

    pending = bytearray()
    overlap_tail = b""
    accepted_history = ""
    sequence = 0

    try:
        await websocket.send_json({"type": "status", "status": "loading_model"})
        model = await get_model()
        await websocket.send_json({
            "type": "status",
            "status": "ready",
            "message": f"{CONFIG.get('model_size','small')} / {DEVICE_RESOLVED} / {COMPUTE_RESOLVED}",
        })

        while True:
            message = await websocket.receive()

            if message.get("type") == "websocket.disconnect":
                break

            text_message = message.get("text")
            if text_message:
                try:
                    data = json.loads(text_message)
                    if data.get("type") == "config" and data.get("language"):
                        language = str(data["language"])
                except Exception:
                    pass
                continue

            raw = message.get("bytes")
            if not raw:
                continue

            pending.extend(raw)

            while len(pending) >= chunk_bytes:
                new_audio = bytes(pending[:chunk_bytes])
                del pending[:chunk_bytes]

                window = overlap_tail + new_audio
                overlap_tail = new_audio[-overlap_bytes:] if overlap_bytes > 0 else b""

                audio = pcm16_to_float32(window)
                raw_text = await asyncio.to_thread(transcribe_sync, model, audio, language)
                unique_text = dedupe_overlap(accepted_history[-500:], raw_text)

                if unique_text:
                    sequence += 1
                    accepted_history = normalize_text(f"{accepted_history} {unique_text}")[-2000:]
                    await websocket.send_json({
                        "type": "transcript",
                        "sequence": sequence,
                        "text": unique_text,
                        "raw": raw_text,
                        "new_seconds": chunk_seconds,
                        "window_seconds": chunk_seconds + overlap_seconds,
                    })

    except WebSocketDisconnect:
        pass
    except Exception as error:
        log.exception("WebSocket transcription error")
        try:
            await websocket.send_json({"type": "error", "message": str(error)})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn
    print()
    print("=" * 68)
    print(" YouTube Live Local STT Server")
    print(" http://127.0.0.1:8765/health")
    print(" 첫 STT 시작 시 Whisper 모델이 자동 다운로드/로드될 수 있습니다.")
    print(" 종료: Ctrl+C")
    print("=" * 68)
    print()
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")

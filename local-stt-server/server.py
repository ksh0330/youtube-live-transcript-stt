from __future__ import annotations

import asyncio
import contextlib
import gc
import json
import logging
import time
from pathlib import Path
from typing import Any

from cuda_runtime import (
    CUDA_RUNTIME_DLLS,
    register_cuda_dll_directories,
    windows_dll_loadable,
)

# Must run before importing faster_whisper/ctranslate2. Handles are retained by
# cuda_runtime so the directories remain active for this Python process.
CUDA_DLL_DIRECTORIES = register_cuda_dll_directories()

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from faster_whisper import WhisperModel

from streaming import (
    BoundedAudioBuffer,
    TranscriptSegment,
    TranscriptStabilizer,
    map_model_segments,
    normalize_text,
)

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "server_config.json"
SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2

with CONFIG_PATH.open("r", encoding="utf-8") as config_file:
    CONFIG: dict[str, Any] = json.load(config_file)

DEBUG_LOGGING = bool(CONFIG.get("debug_logging", False))
logging.basicConfig(
    level=logging.DEBUG if DEBUG_LOGGING else logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)
if not DEBUG_LOGGING:
    logging.getLogger("faster_whisper").setLevel(logging.WARNING)
    logging.getLogger("ctranslate2").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("huggingface_hub").setLevel(logging.WARNING)
log = logging.getLogger("yt-live-stt")

MODEL: WhisperModel | None = None
MODEL_LOCK = asyncio.Lock()
INFERENCE_LOCK = asyncio.Lock()
MODEL_LOAD_ERROR: str | None = None
DEVICE_RESOLVED = "unloaded"
COMPUTE_RESOLVED = "unloaded"
GPU_RUNTIME_STATUS = "unchecked"
ACTIVE_CONNECTIONS = 0
LAST_METRICS: dict[str, float | int] = {}

class ModelLoadError(RuntimeError):
    """Stable, user-facing model load failure cached for this server process."""


def config_float(
    name: str, default: float, minimum: float, maximum: float
) -> float:
    try:
        value = float(CONFIG.get(name, default))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


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


def _missing_cuda_runtime_dlls() -> tuple[str, ...]:
    return tuple(name for name in CUDA_RUNTIME_DLLS if not windows_dll_loadable(name))


def _summarize_model_error(error: BaseException) -> str:
    message = " ".join(str(error).split())
    lowered = message.lower()
    if "mkl_malloc" in lowered or "failed to allocate memory" in lowered:
        return "memory allocation error"
    return message or type(error).__name__


def _release_model(model: WhisperModel | None) -> None:
    if model is None:
        return
    backend = getattr(model, "model", model)
    unload_model = getattr(backend, "unload_model", None)
    if callable(unload_model):
        try:
            unload_model()
        except Exception as error:
            log.warning("Failed to unload rejected model cleanly: %s", error)


def _probe_model_inference(model: WhisperModel) -> None:
    """Force a real encoder pass so missing CUDA runtime DLLs fail early."""
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
    list(segments)


def _load_model_sync() -> WhisperModel:
    global DEVICE_RESOLVED, COMPUTE_RESOLVED, GPU_RUNTIME_STATUS

    model_size = str(CONFIG.get("model_size", "small"))
    device, compute = _resolve_device()
    log.info("Whisper model loading: model=%s device=%s compute=%s", model_size, device, compute)

    fallback_reason: str | None = None
    if device == "cuda":
        missing_dlls = _missing_cuda_runtime_dlls()
        if missing_dlls:
            GPU_RUNTIME_STATUS = f"missing: {', '.join(missing_dlls)}"
            fallback_reason = (
                "GPU runtime unavailable: missing " + ", ".join(missing_dlls)
            )
            log.warning(
                "%s. CUDA model creation skipped; falling back to CPU int8.",
                fallback_reason,
            )
        else:
            GPU_RUNTIME_STATUS = "available"
            gpu_model: WhisperModel | None = None
            try:
                gpu_model = WhisperModel(
                    model_size, device="cuda", compute_type=compute
                )
                _probe_model_inference(gpu_model)
                DEVICE_RESOLVED, COMPUTE_RESOLVED = "cuda", compute
                log.info("Whisper model ready: %s / cuda / %s", model_size, compute)
                return gpu_model
            except Exception as cuda_error:
                fallback_reason = (
                    "GPU inference unavailable: "
                    + _summarize_model_error(cuda_error)
                )
                log.warning("%s. Falling back to CPU int8.", fallback_reason)
                _release_model(gpu_model)
                gpu_model = None
                gc.collect()
    else:
        GPU_RUNTIME_STATUS = "not_requested"

    cpu_model: WhisperModel | None = None
    try:
        cpu_model = WhisperModel(model_size, device="cpu", compute_type="int8")
        _probe_model_inference(cpu_model)
        DEVICE_RESOLVED, COMPUTE_RESOLVED = "cpu", "int8"
        log.info("Whisper model ready: %s / cpu / int8", model_size)
        return cpu_model
    except Exception as cpu_error:
        _release_model(cpu_model)
        cpu_model = None
        gc.collect()
        cpu_message = _summarize_model_error(cpu_error)
        if fallback_reason:
            raise ModelLoadError(
                f"{fallback_reason}\nCPU fallback failed: {cpu_message}"
            ) from None
        raise ModelLoadError(f"CPU model loading failed: {cpu_message}") from None


async def get_model() -> WhisperModel:
    global MODEL, MODEL_LOAD_ERROR, DEVICE_RESOLVED, COMPUTE_RESOLVED
    if MODEL is not None:
        return MODEL
    if MODEL_LOAD_ERROR is not None:
        raise ModelLoadError(MODEL_LOAD_ERROR)
    async with MODEL_LOCK:
        if MODEL is not None:
            return MODEL
        if MODEL_LOAD_ERROR is not None:
            raise ModelLoadError(MODEL_LOAD_ERROR)
        try:
            MODEL = await asyncio.to_thread(_load_model_sync)
        except Exception as error:
            MODEL_LOAD_ERROR = (
                str(error)
                if isinstance(error, ModelLoadError)
                else f"Whisper model loading failed: {_summarize_model_error(error)}"
            )
            DEVICE_RESOLVED, COMPUTE_RESOLVED = "error", "error"
            log.error("Whisper model unavailable: %s", MODEL_LOAD_ERROR)
            raise ModelLoadError(MODEL_LOAD_ERROR) from None
    return MODEL


def pcm16_to_float32(raw: bytes) -> np.ndarray:
    if not raw:
        return np.zeros((0,), dtype=np.float32)
    usable = len(raw) - (len(raw) % BYTES_PER_SAMPLE)
    if usable <= 0:
        return np.zeros((0,), dtype=np.float32)
    samples = np.frombuffer(raw[:usable], dtype="<i2").astype(np.float32)
    return samples / 32768.0


def build_initial_prompt(client_prompt: str = "") -> str | None:
    default_prompt = normalize_text(str(CONFIG.get("initial_prompt", "")))
    client = normalize_text(client_prompt)[:1000]
    if not bool(CONFIG.get("allow_client_prompt", True)):
        client = ""
    combined = normalize_text(f"{default_prompt} {client}")
    return combined or None


def transcribe_sync(
    model: WhisperModel,
    audio: np.ndarray,
    language: str,
    initial_prompt: str | None,
) -> list[TranscriptSegment]:
    if audio.size == 0:
        return []

    vad_parameters = {
        "threshold": config_float("vad_threshold", 0.5, 0.0, 1.0),
        "min_speech_duration_ms": int(
            config_float("vad_min_speech_duration_ms", 250, 0, 5000)
        ),
        "min_silence_duration_ms": int(
            config_float("vad_min_silence_duration_ms", 500, 100, 5000)
        ),
        "speech_pad_ms": int(config_float("vad_speech_pad_ms", 300, 0, 2000)),
    }
    segments, _info = model.transcribe(
        audio,
        language=language or None,
        beam_size=int(CONFIG.get("beam_size", 1)),
        vad_filter=bool(CONFIG.get("vad_filter", True)),
        vad_parameters=vad_parameters,
        condition_on_previous_text=False,
        initial_prompt=initial_prompt,
        temperature=0.0,
        word_timestamps=bool(CONFIG.get("word_timestamps", False)),
        no_speech_threshold=config_float("no_speech_threshold", 0.6, 0.0, 1.0),
        log_prob_threshold=config_float("log_prob_threshold", -1.0, -5.0, 0.0),
        compression_ratio_threshold=config_float(
            "compression_ratio_threshold", 2.4, 1.0, 10.0
        ),
        hallucination_silence_threshold=(
            config_float("hallucination_silence_threshold", 2.0, 0.1, 10.0)
            if CONFIG.get("hallucination_silence_threshold") is not None
            else None
        ),
    )
    # Segment timestamps are relative to the supplied rolling audio window.
    return map_model_segments(list(segments), 0.0)


async def receive_audio(
    websocket: WebSocket,
    audio_buffer: BoundedAudioBuffer,
    client_config: dict[str, str],
    graceful_stop: asyncio.Event,
) -> None:
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                return

            text_message = message.get("text")
            if text_message:
                try:
                    data = json.loads(text_message)
                except (TypeError, ValueError):
                    continue
                if data.get("type") == "config":
                    if data.get("language"):
                        client_config["language"] = str(data["language"])
                    client_config["initial_prompt"] = str(
                        data.get("initial_prompt") or ""
                    )
                elif data.get("type") == "stop":
                    graceful_stop.set()
                    audio_buffer.keep_latest(
                        config_float("chunk_seconds", 4.0, 2.0, 10.0)
                    )
                    return
                continue

            raw = message.get("bytes")
            if raw:
                audio_buffer.append(raw)
    except WebSocketDisconnect:
        return
    finally:
        audio_buffer.close()


async def websocket_send_json(websocket: WebSocket, payload: dict[str, Any]) -> bool:
    try:
        await websocket.send_json(payload)
        return True
    except Exception:
        return False


async def process_audio(
    websocket: WebSocket,
    model: WhisperModel,
    audio_buffer: BoundedAudioBuffer,
    client_config: dict[str, str],
    graceful_stop: asyncio.Event,
) -> None:
    global LAST_METRICS

    chunk_seconds = config_float("chunk_seconds", 4.0, 2.0, 10.0)
    overlap_seconds = min(
        config_float("overlap_seconds", 2.0, 0.0, 5.0), chunk_seconds
    )
    horizon_seconds = min(
        config_float("commit_horizon_seconds", 2.0, 0.5, 4.0),
        max(0.5, overlap_seconds or chunk_seconds),
    )
    minimum_flush_seconds = config_float("minimum_flush_seconds", 1.0, 0.25, 3.0)
    chunk_bytes = int(SAMPLE_RATE * BYTES_PER_SAMPLE * chunk_seconds)
    overlap_bytes = int(SAMPLE_RATE * BYTES_PER_SAMPLE * overlap_seconds)
    minimum_flush_bytes = int(SAMPLE_RATE * BYTES_PER_SAMPLE * minimum_flush_seconds)

    stabilizer = TranscriptStabilizer(
        horizon_seconds,
        config_float("reprediction_tolerance_seconds", 1.0, 0.25, 3.0),
    )
    overlap_tail = b""
    previous_new_end_sample: int | None = None
    sequence = 0
    latest_audio_end = 0.0

    async def process_chunk(raw: bytes, start_sample: int) -> bool:
        nonlocal overlap_tail, previous_new_end_sample, sequence, latest_audio_end

        sample_count = len(raw) // BYTES_PER_SAMPLE
        contiguous = previous_new_end_sample is None or start_sample == previous_new_end_sample
        if not contiguous:
            overlap_tail = b""
            log.warning(
                "Audio backlog overflow: skipped %.2fs to preserve live position.",
                max(0.0, (start_sample - (previous_new_end_sample or 0)) / SAMPLE_RATE),
            )

        window = overlap_tail + raw
        window_start_sample = start_sample - len(overlap_tail) // BYTES_PER_SAMPLE
        window_start = window_start_sample / SAMPLE_RATE
        latest_audio_end = (start_sample + sample_count) / SAMPLE_RATE
        previous_new_end_sample = start_sample + sample_count
        overlap_tail = raw[-overlap_bytes:] if overlap_bytes > 0 else b""

        audio = pcm16_to_float32(window)
        started = time.perf_counter()
        async with INFERENCE_LOCK:
            relative_segments = await asyncio.to_thread(
                transcribe_sync,
                model,
                audio,
                client_config.get("language", str(CONFIG.get("language", "ko"))),
                build_initial_prompt(client_config.get("initial_prompt", "")),
            )
        inference_ms = (time.perf_counter() - started) * 1000
        absolute_segments = [
            TranscriptSegment(
                window_start + item.start,
                window_start + item.end,
                item.text,
            )
            for item in relative_segments
        ]
        finalized, provisional = stabilizer.update(
            absolute_segments,
            window_start=window_start,
            audio_end=latest_audio_end,
        )
        sequence += 1
        LAST_METRICS = {
            "sequence": sequence,
            "inference_ms": round(inference_ms, 1),
            "queue_seconds": round(audio_buffer.seconds, 3),
            "dropped_seconds": round(audio_buffer.dropped_seconds, 3),
            "audio_end": round(latest_audio_end, 3),
        }
        if DEBUG_LOGGING:
            log.debug(
                "window=%0.2f-%0.2f inference=%0.0fms queue=%0.2fs final=%d provisional=%d",
                window_start,
                latest_audio_end,
                inference_ms,
                audio_buffer.seconds,
                len(finalized),
                len(provisional),
            )
        return await websocket_send_json(
            websocket,
            {
                "type": "transcript_update",
                "sequence": sequence,
                "finalized": [item.as_dict() for item in finalized],
                "provisional": [item.as_dict() for item in provisional],
                "new_seconds": round(sample_count / SAMPLE_RATE, 3),
                "window_seconds": round(len(window) / BYTES_PER_SAMPLE / SAMPLE_RATE, 3),
                **LAST_METRICS,
            },
        )

    while True:
        item = await audio_buffer.pop(chunk_bytes)
        if item is None:
            break
        raw, start_sample = item
        if not await process_chunk(raw, start_sample):
            return

    remaining = audio_buffer.pop_remaining(minimum_flush_bytes)
    if remaining and graceful_stop.is_set():
        raw, start_sample = remaining
        if not await process_chunk(raw, start_sample):
            return

    flushed = stabilizer.flush()
    if flushed and graceful_stop.is_set():
        sequence += 1
        await websocket_send_json(
            websocket,
            {
                "type": "transcript_update",
                "sequence": sequence,
                "finalized": [item.as_dict() for item in flushed],
                "provisional": [],
                "audio_end": round(latest_audio_end, 3),
                "inference_ms": 0,
                "queue_seconds": round(audio_buffer.seconds, 3),
                "dropped_seconds": round(audio_buffer.dropped_seconds, 3),
            },
        )

    if graceful_stop.is_set():
        await websocket_send_json(websocket, {"type": "stop_ack"})


app = FastAPI(title="YouTube Live Local STT", version="0.3.1")


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
        "model_error": MODEL_LOAD_ERROR,
        "gpu_runtime_status": GPU_RUNTIME_STATUS,
        "cuda_dll_directories": [str(path) for path in CUDA_DLL_DIRECTORIES],
        "automatic_cpu_fallback": True,
        "chunk_seconds": config_float("chunk_seconds", 4.0, 2.0, 10.0),
        "overlap_seconds": config_float("overlap_seconds", 2.0, 0.0, 5.0),
        "commit_horizon_seconds": config_float(
            "commit_horizon_seconds", 2.0, 0.5, 4.0
        ),
        "queue_max_seconds": config_float("queue_max_seconds", 16.0, 4.0, 120.0),
        "active_connections": ACTIVE_CONNECTIONS,
        "last_metrics": LAST_METRICS,
    }


@app.post("/warmup")
async def warmup() -> Any:
    try:
        await get_model()
    except ModelLoadError as error:
        from fastapi.responses import JSONResponse

        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "model_loaded": False,
                "error": str(error),
            },
        )
    return {
        "ok": True,
        "model_loaded": True,
        "model_size": CONFIG.get("model_size", "small"),
        "device_resolved": DEVICE_RESOLVED,
        "compute_type": COMPUTE_RESOLVED,
    }


@app.websocket("/ws/transcribe")
async def websocket_transcribe(websocket: WebSocket) -> None:
    global ACTIVE_CONNECTIONS

    await websocket.accept()
    ACTIVE_CONNECTIONS += 1
    audio_buffer = BoundedAudioBuffer(
        SAMPLE_RATE, config_float("queue_max_seconds", 16.0, 4.0, 120.0)
    )
    client_config = {
        "language": str(CONFIG.get("language", "ko")),
        "initial_prompt": "",
    }
    graceful_stop = asyncio.Event()
    receiver: asyncio.Task[None] | None = None

    try:
        await websocket.send_json({"type": "status", "status": "loading_model"})
        model = await get_model()
        await websocket.send_json(
            {
                "type": "status",
                "status": "ready",
                "message": f"{CONFIG.get('model_size','small')} / {DEVICE_RESOLVED} / {COMPUTE_RESOLVED}",
            }
        )
        log.info("STT started")
        receiver = asyncio.create_task(
            receive_audio(websocket, audio_buffer, client_config, graceful_stop)
        )
        await process_audio(
            websocket, model, audio_buffer, client_config, graceful_stop
        )
        await receiver
        log.info("STT stopped")
    except WebSocketDisconnect:
        pass
    except ModelLoadError as error:
        log.error("WebSocket model unavailable: %s", error)
        await websocket_send_json(
            websocket,
            {"type": "error", "status": "model_unavailable", "message": str(error)},
        )
    except Exception as error:
        log.exception("WebSocket transcription error")
        await websocket_send_json(
            websocket, {"type": "error", "message": str(error)}
        )
    finally:
        audio_buffer.close()
        if receiver and not receiver.done():
            receiver.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await receiver
        ACTIVE_CONNECTIONS = max(0, ACTIVE_CONNECTIONS - 1)
        with contextlib.suppress(Exception):
            await websocket.close()


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
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8765,
        log_level="debug" if DEBUG_LOGGING else "warning",
    )

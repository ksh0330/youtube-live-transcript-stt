from __future__ import annotations

import asyncio
import sys
import time
import unittest
import warnings
from dataclasses import dataclass
from pathlib import Path
from unittest import mock

import numpy as np

warnings.filterwarnings(
    "ignore",
    message="Using `httpx` with `starlette.testclient` is deprecated.*",
    category=UserWarning,
)
from fastapi.testclient import TestClient

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import server  # noqa: E402


@dataclass
class FakeSegment:
    start: float
    end: float
    text: str


class FakeModel:
    def __init__(self, segments: list[FakeSegment]) -> None:
        self.segments = segments
        self.kwargs = None

    def transcribe(self, _audio: np.ndarray, **kwargs):
        self.kwargs = kwargs
        return iter(self.segments), object()


class ServerAudioTests(unittest.TestCase):
    def test_empty_pcm_and_empty_audio(self) -> None:
        self.assertEqual(server.pcm16_to_float32(b"").size, 0)
        self.assertEqual(
            server.transcribe_sync(FakeModel([]), np.zeros(0), "ko", None), []
        )

    def test_silence_with_no_segments_returns_empty(self) -> None:
        model = FakeModel([])
        result = server.transcribe_sync(
            model, np.zeros(server.SAMPLE_RATE, dtype=np.float32), "ko", None
        )
        self.assertEqual(result, [])
        self.assertTrue(model.kwargs["vad_filter"])
        self.assertEqual(model.kwargs["vad_parameters"]["min_silence_duration_ms"], 500)

    def test_segment_timestamp_is_kept_relative_to_window(self) -> None:
        model = FakeModel([FakeSegment(1.2, 4.1, "문장")])
        result = server.transcribe_sync(
            model, np.zeros(server.SAMPLE_RATE, dtype=np.float32), "ko", "prompt"
        )
        self.assertEqual(result[0].start, 1.2)
        self.assertEqual(result[0].end, 4.1)
        self.assertEqual(model.kwargs["initial_prompt"], "prompt")
        self.assertFalse(model.kwargs["word_timestamps"])


class ConfigTests(unittest.TestCase):
    def test_local_config_overrides_defaults(self) -> None:
        import json
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "server_config.json"
            local = Path(directory) / "server_config.local.json"
            base.write_text(json.dumps({"model_size": "small", "language": "ko"}), "utf-8")
            self.assertEqual(server.load_config(base, local)["model_size"], "small")

            # Notepad on Windows may save with a UTF-8 BOM.
            local.write_text(json.dumps({"model_size": "large-v3-turbo"}), "utf-8-sig")
            config = server.load_config(base, local)
            self.assertEqual(config["model_size"], "large-v3-turbo")
            self.assertEqual(config["language"], "ko")


class StreamingModeReportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.saved = (server.MODEL, server.DEVICE_RESOLVED, dict(server.CONFIG))

    def tearDown(self) -> None:
        server.MODEL, server.DEVICE_RESOLVED, config = self.saved
        server.CONFIG.clear()
        server.CONFIG.update(config)

    def test_health_reports_auto_until_the_model_decides_the_device(self) -> None:
        server.CONFIG["streaming_mode"] = "auto"
        server.MODEL, server.DEVICE_RESOLVED = None, "unloaded"
        self.assertEqual(asyncio.run(server.health())["streaming_mode"], "auto")

        server.MODEL, server.DEVICE_RESOLVED = FakeModel([]), "cuda"
        self.assertEqual(asyncio.run(server.health())["streaming_mode"], "sentence")

        server.CONFIG["streaming_mode"] = "rolling"
        server.MODEL = None
        self.assertEqual(asyncio.run(server.health())["streaming_mode"], "rolling")


class FakeBackend:
    def __init__(self, events: list[str] | None = None, name: str = "model") -> None:
        self.events = events
        self.name = name
        self.unload_calls = 0

    def unload_model(self) -> None:
        self.unload_calls += 1
        if self.events is not None:
            self.events.append(f"unload:{self.name}")


class FakeLoadModel(FakeModel):
    def __init__(self, events: list[str] | None = None, name: str = "model") -> None:
        super().__init__([])
        self.model = FakeBackend(events, name)


class ModelLoadingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_config = dict(server.CONFIG)
        self.original_device = server.DEVICE_RESOLVED
        self.original_compute = server.COMPUTE_RESOLVED
        self.original_gpu_status = server.GPU_RUNTIME_STATUS
        server.CONFIG.update({"model_size": "small", "device": "auto", "compute_type": "auto"})

    def tearDown(self) -> None:
        server.CONFIG.clear()
        server.CONFIG.update(self.original_config)
        server.DEVICE_RESOLVED = self.original_device
        server.COMPUTE_RESOLVED = self.original_compute
        server.GPU_RUNTIME_STATUS = self.original_gpu_status

    def test_forced_cpu_loads_small_int8_without_cuda_check(self) -> None:
        created: list[tuple[str, str]] = []

        def create_model(_size: str, *, device: str, compute_type: str):
            created.append((device, compute_type))
            return FakeLoadModel()

        with (
            mock.patch.object(server, "_resolve_device", return_value=("cpu", "int8")),
            mock.patch.object(server, "_missing_cuda_runtime_dlls") as dll_check,
            mock.patch.object(server, "WhisperModel", side_effect=create_model),
            mock.patch.object(server, "_probe_model_inference"),
        ):
            model = server._load_model_sync()

        self.assertIsInstance(model, FakeLoadModel)
        self.assertEqual(created, [("cpu", "int8")])
        self.assertEqual(server.DEVICE_RESOLVED, "cpu")
        self.assertEqual(server.COMPUTE_RESOLVED, "int8")
        dll_check.assert_not_called()

    def test_missing_cuda_dlls_skip_gpu_model_creation(self) -> None:
        created: list[tuple[str, str]] = []

        def create_model(_size: str, *, device: str, compute_type: str):
            created.append((device, compute_type))
            return FakeLoadModel()

        with (
            mock.patch.object(server, "_resolve_device", return_value=("cuda", "float16")),
            mock.patch.object(
                server,
                "_missing_cuda_runtime_dlls",
                return_value=("cublas64_12.dll", "cudnn64_9.dll"),
            ),
            mock.patch.object(server, "WhisperModel", side_effect=create_model),
            mock.patch.object(server, "_probe_model_inference"),
        ):
            model = server._load_model_sync()

        self.assertIsInstance(model, FakeLoadModel)
        self.assertEqual(created, [("cpu", "int8")])
        self.assertEqual(server.DEVICE_RESOLVED, "cpu")
        self.assertIn("cublas64_12.dll", server.GPU_RUNTIME_STATUS)

    def test_cuda_preflight_failure_unloads_before_cpu_creation(self) -> None:
        events: list[str] = []
        models: dict[str, FakeLoadModel] = {}

        def create_model(_size: str, *, device: str, compute_type: str):
            events.append(f"create:{device}:{compute_type}")
            model = FakeLoadModel(events, device)
            models[device] = model
            return model

        def probe(model: FakeLoadModel) -> None:
            device = model.model.name
            events.append(f"probe:{device}")
            if device == "cuda":
                raise RuntimeError("CUDA preflight failed")

        with (
            mock.patch.object(server, "_resolve_device", return_value=("cuda", "float16")),
            mock.patch.object(server, "_missing_cuda_runtime_dlls", return_value=()),
            mock.patch.object(server, "WhisperModel", side_effect=create_model),
            mock.patch.object(server, "_probe_model_inference", side_effect=probe),
            mock.patch.object(server.gc, "collect") as collect,
        ):
            model = server._load_model_sync()

        self.assertIs(model, models["cpu"])
        self.assertEqual(models["cuda"].model.unload_calls, 1)
        self.assertLess(events.index("unload:cuda"), events.index("create:cpu:int8"))
        collect.assert_called_once()

    def test_cpu_fallback_failure_has_clear_memory_error(self) -> None:
        with (
            mock.patch.object(server, "_resolve_device", return_value=("cuda", "float16")),
            mock.patch.object(
                server,
                "_missing_cuda_runtime_dlls",
                return_value=server.CUDA_RUNTIME_DLLS,
            ),
            mock.patch.object(
                server,
                "WhisperModel",
                side_effect=RuntimeError("mkl_malloc: failed to allocate memory"),
            ),
        ):
            with self.assertRaises(server.ModelLoadError) as raised:
                server._load_model_sync()

        message = str(raised.exception)
        self.assertIn("GPU runtime unavailable", message)
        self.assertIn("CPU fallback failed: memory allocation error", message)


class ModelSingleFlightTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.original_model = server.MODEL
        self.original_error = server.MODEL_LOAD_ERROR
        self.original_lock = server.MODEL_LOCK
        server.MODEL = None
        server.MODEL_LOAD_ERROR = None
        server.MODEL_LOCK = asyncio.Lock()

    async def asyncTearDown(self) -> None:
        server.MODEL = self.original_model
        server.MODEL_LOAD_ERROR = self.original_error
        server.MODEL_LOCK = self.original_lock

    async def test_concurrent_requests_share_one_successful_load(self) -> None:
        loaded = FakeLoadModel()

        def load_once():
            time.sleep(0.05)
            return loaded

        with mock.patch.object(server, "_load_model_sync", side_effect=load_once) as load:
            results = await asyncio.gather(*(server.get_model() for _ in range(5)))

        self.assertTrue(all(result is loaded for result in results))
        self.assertEqual(load.call_count, 1)

    async def test_failed_load_is_shared_and_not_retried(self) -> None:
        def fail_once():
            time.sleep(0.05)
            raise server.ModelLoadError("CPU fallback failed: memory allocation error")

        with mock.patch.object(server, "_load_model_sync", side_effect=fail_once) as load:
            results = await asyncio.gather(
                *(server.get_model() for _ in range(5)), return_exceptions=True
            )
            with self.assertRaisesRegex(server.ModelLoadError, "memory allocation"):
                await server.get_model()

        self.assertTrue(all(isinstance(result, server.ModelLoadError) for result in results))
        self.assertEqual(load.call_count, 1)

    async def test_warmup_returns_structured_cached_error(self) -> None:
        server.MODEL_LOAD_ERROR = (
            "GPU runtime unavailable\n"
            "CPU fallback failed: memory allocation error"
        )

        response = await server.warmup()

        self.assertEqual(response.status_code, 503)
        self.assertIn(b"GPU runtime unavailable", response.body)
        self.assertIn(b"CPU fallback failed", response.body)


class WebSocketLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_model = server.MODEL
        self.original_config = dict(server.CONFIG)
        server.MODEL = FakeModel([FakeSegment(0.2, 1.8, "WebSocket 테스트")])
        server.CONFIG.update({
            "chunk_seconds": 2.0,
            "overlap_seconds": 1.0,
            "commit_horizon_seconds": 1.0,
            "queue_max_seconds": 4.0,
            "minimum_flush_seconds": 0.25,
        })

    def tearDown(self) -> None:
        server.MODEL = self.original_model
        server.CONFIG.clear()
        server.CONFIG.update(self.original_config)

    def _run_session(self) -> list[dict]:
        messages = []
        pcm = np.zeros(server.SAMPLE_RATE * 2, dtype="<i2").tobytes()
        with TestClient(server.app).websocket_connect("/ws/transcribe") as websocket:
            self.assertEqual(websocket.receive_json()["status"], "loading_model")
            self.assertEqual(websocket.receive_json()["status"], "ready")
            websocket.send_json({"type": "config", "language": "ko"})
            websocket.send_bytes(pcm)
            messages.append(websocket.receive_json())
            websocket.send_json({"type": "stop"})
            while True:
                message = websocket.receive_json()
                messages.append(message)
                if message.get("type") == "stop_ack":
                    break
        return messages

    def test_graceful_stop_flushes_provisional_and_restart_resets_sequence(self) -> None:
        first = self._run_session()
        self.assertEqual(first[0]["type"], "transcript_update")
        self.assertEqual(first[0]["sequence"], 1)
        self.assertEqual(first[0]["provisional"][0]["text"], "WebSocket 테스트")
        flushed = [item for item in first if item.get("finalized")]
        self.assertEqual(flushed[-1]["finalized"][0]["text"], "WebSocket 테스트")
        # The flush sent on stop carries the same mode and language as other updates.
        self.assertEqual(flushed[-1]["mode"], first[0]["mode"])
        self.assertEqual(flushed[-1]["language"], "ko")

        restarted = self._run_session()
        self.assertEqual(restarted[0]["sequence"], 1)

    def test_reset_after_a_jump_starts_a_new_generation(self) -> None:
        pcm = np.zeros(server.SAMPLE_RATE * 2, dtype="<i2").tobytes()
        with TestClient(server.app).websocket_connect("/ws/transcribe") as websocket:
            websocket.receive_json()
            websocket.receive_json()
            websocket.send_json({"type": "config", "language": "ko"})
            websocket.send_bytes(pcm)
            before = websocket.receive_json()
            websocket.send_json({"type": "reset", "generation": 1})
            websocket.send_bytes(pcm)
            after = websocket.receive_json()
            websocket.send_json({"type": "stop"})
            flushed = []
            while True:
                message = websocket.receive_json()
                if message.get("type") == "stop_ack":
                    break
                flushed.append(message)

        self.assertEqual(before["generation"], 0)
        self.assertEqual(after["generation"], 1)
        # The sentence from before the jump is not carried over as text after it.
        self.assertEqual(after["finalized"], [])
        self.assertTrue(all(item["generation"] == 1 for item in flushed))


@dataclass
class FakeWord:
    start: float
    end: float
    word: str


@dataclass
class FakeWordSegment:
    start: float
    end: float
    text: str
    words: list


class SentenceModeWebSocketTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_model = server.MODEL
        self.original_config = dict(server.CONFIG)
        server.MODEL = FakeModel([
            FakeWordSegment(0.1, 1.6, " 문장 모드 테스트입니다.", [
                FakeWord(0.1, 0.5, " 문장"),
                FakeWord(0.5, 0.9, " 모드"),
                FakeWord(0.9, 1.6, " 테스트입니다."),
            ])
        ])
        server.CONFIG.update({
            "streaming_mode": "sentence",
            "sentence_chunk_seconds": 1.0,
            "queue_max_seconds": 8.0,
            "minimum_flush_seconds": 0.25,
        })

    def tearDown(self) -> None:
        server.MODEL = self.original_model
        server.CONFIG.clear()
        server.CONFIG.update(self.original_config)

    def test_agreed_words_become_one_sentence(self) -> None:
        pcm = np.zeros(server.SAMPLE_RATE, dtype="<i2").tobytes()
        updates = []
        with TestClient(server.app).websocket_connect("/ws/transcribe") as websocket:
            websocket.receive_json()
            websocket.receive_json()
            websocket.send_bytes(pcm)
            updates.append(websocket.receive_json())
            websocket.send_bytes(pcm)
            updates.append(websocket.receive_json())
            websocket.send_json({"type": "stop"})
            while True:
                message = websocket.receive_json()
                if message.get("type") == "stop_ack":
                    break
                updates.append(message)

        self.assertEqual(updates[0]["mode"], "sentence")
        # First pass: nothing agreed yet, the whole hypothesis is unstable.
        self.assertEqual(updates[0]["finalized"], [])
        self.assertEqual(updates[0]["provisional"][0]["text"], "문장 모드 테스트입니다.")
        self.assertNotIn("stable", updates[0]["provisional"][0])
        # Second pass agrees, and the sentence punctuation completes it.
        finalized = [item["text"] for update in updates for item in update["finalized"]]
        self.assertEqual(finalized, ["문장 모드 테스트입니다."])


if __name__ == "__main__":
    unittest.main()

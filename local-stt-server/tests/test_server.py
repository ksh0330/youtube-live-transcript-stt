from __future__ import annotations

import sys
import unittest
import warnings
from dataclasses import dataclass
from pathlib import Path

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

        restarted = self._run_session()
        self.assertEqual(restarted[0]["sequence"], 1)


if __name__ == "__main__":
    unittest.main()

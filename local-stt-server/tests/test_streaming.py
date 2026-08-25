from __future__ import annotations

import asyncio
import sys
import unittest
from dataclasses import dataclass
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from streaming import (  # noqa: E402
    BoundedAudioBuffer,
    TranscriptSegment,
    TranscriptStabilizer,
    map_model_segments,
    merge_overlapping_text,
    remove_overlap,
)


class TextMergeTests(unittest.TestCase):
    def test_token_overlap(self) -> None:
        merged = merge_overlapping_text(
            "고정 소수점에서는 정수부와 소수부를",
            "정수부와 소수부를 함께 표현할 수 있습니다",
        )
        self.assertEqual(
            merged,
            "고정 소수점에서는 정수부와 소수부를 함께 표현할 수 있습니다",
        )

    def test_incoming_extension(self) -> None:
        self.assertEqual(
            remove_overlap("32비트 안에서", "32비트 안에서 8번째 소수점이"),
            "8번째 소수점이",
        )

    def test_korean_spacing_difference(self) -> None:
        self.assertEqual(
            merge_overlapping_text("고정 소수점", "고정소수점 체계를 설명합니다"),
            "고정 소수점 체계를 설명합니다",
        )

    def test_one_character_insertion_in_overlap(self) -> None:
        self.assertEqual(
            merge_overlapping_text(
                "스킬링 팩터를 사용하면",
                "스케일링 팩터를 사용하면 8번째 비트 위치를",
            ),
            "스킬링 팩터를 사용하면 8번째 비트 위치를",
        )


class StabilizerTests(unittest.TestCase):
    def test_provisional_becomes_final_after_horizon(self) -> None:
        stabilizer = TranscriptStabilizer(commit_horizon_seconds=2.0)
        final, provisional = stabilizer.update(
            [TranscriptSegment(0.0, 3.8, "32비트 안에서")],
            window_start=0.0,
            audio_end=4.0,
        )
        self.assertEqual(final, [])
        self.assertEqual([item.text for item in provisional], ["32비트 안에서"])

        final, provisional = stabilizer.update(
            [TranscriptSegment(2.0, 5.5, "32비트 안에서 8번째 소수점이")],
            window_start=2.0,
            audio_end=8.0,
        )
        self.assertEqual([item.text for item in final], ["32비트 안에서 8번째 소수점이"])
        self.assertEqual(provisional, [])

    def test_previous_provisional_prefix_is_not_lost_at_next_window(self) -> None:
        stabilizer = TranscriptStabilizer(commit_horizon_seconds=2.0)
        stabilizer.update(
            [TranscriptSegment(0.0, 3.9, "오늘은 고정 소수점 수 체계에서 32비트 안의 정수부와")],
            window_start=0.0,
            audio_end=4.0,
        )
        final, _ = stabilizer.update(
            [TranscriptSegment(2.0, 5.8, "정수부와 소수부를 함께 표현할 수 있습니다")],
            window_start=2.0,
            audio_end=8.0,
        )
        self.assertEqual(
            final[0].text,
            "오늘은 고정 소수점 수 체계에서 32비트 안의 정수부와 소수부를 함께 표현할 수 있습니다",
        )

    def test_old_provisional_is_kept_when_next_window_moves_to_new_sentence(self) -> None:
        stabilizer = TranscriptStabilizer(commit_horizon_seconds=2.0)
        stabilizer.update(
            [TranscriptSegment(0.0, 4.0, "오늘은 고정 소수점 수 체계를 설명하겠습니다")],
            window_start=0.0,
            audio_end=4.0,
        )
        first_final, _ = stabilizer.update(
            [TranscriptSegment(2.0, 8.2, "32비트 안에서 정수부와 소수부를 함께 표현합니다")],
            window_start=2.0,
            audio_end=8.0,
        )
        self.assertEqual(first_final[0].text, "오늘은 고정 소수점 수 체계를 설명하겠습니다")

        second_final, _ = stabilizer.update(
            [TranscriptSegment(6.0, 9.3, "스케일링 팩터를 사용하면")],
            window_start=6.0,
            audio_end=12.0,
        )
        self.assertEqual(
            [item.text for item in second_final],
            ["32비트 안에서 정수부와 소수부를 함께 표현합니다", "스케일링 팩터를 사용하면"],
        )

    def test_chunk_boundary_sentence_is_merged(self) -> None:
        stabilizer = TranscriptStabilizer(commit_horizon_seconds=2.0)
        final, _ = stabilizer.update(
            [TranscriptSegment(0.0, 1.8, "고정 소수점에서는 정수부와 소수부를")],
            window_start=0.0,
            audio_end=4.0,
        )
        self.assertEqual(len(final), 1)
        final, _ = stabilizer.update(
            [TranscriptSegment(1.5, 5.0, "정수부와 소수부를 함께 표현할 수 있습니다")],
            window_start=2.0,
            audio_end=8.0,
        )
        self.assertEqual([item.text for item in final], ["함께 표현할 수 있습니다"])

    def test_real_repeated_sentence_with_time_gap_is_preserved(self) -> None:
        stabilizer = TranscriptStabilizer(commit_horizon_seconds=1.0)
        first, _ = stabilizer.update(
            [TranscriptSegment(0.0, 1.0, "다시 설명하겠습니다")],
            window_start=0.0,
            audio_end=3.0,
        )
        second, _ = stabilizer.update(
            [TranscriptSegment(3.0, 4.0, "다시 설명하겠습니다")],
            window_start=2.0,
            audio_end=6.0,
        )
        self.assertEqual([item.text for item in first + second], [
            "다시 설명하겠습니다",
            "다시 설명하겠습니다",
        ])

    def test_back_to_back_real_repeat_is_preserved(self) -> None:
        stabilizer = TranscriptStabilizer(commit_horizon_seconds=0.5)
        first, _ = stabilizer.update(
            [TranscriptSegment(0.0, 1.0, "중요합니다")],
            window_start=0.0,
            audio_end=2.0,
        )
        second, _ = stabilizer.update(
            [TranscriptSegment(1.2, 2.2, "중요합니다")],
            window_start=1.0,
            audio_end=3.0,
        )
        self.assertEqual([item.text for item in first + second], ["중요합니다", "중요합니다"])


@dataclass
class FakeModelSegment:
    start: float
    end: float
    text: str


class TimestampTests(unittest.TestCase):
    def test_model_timestamps_are_mapped_to_window(self) -> None:
        mapped = map_model_segments(
            [FakeModelSegment(1.2, 4.1, "테스트")], window_start=120.0
        )
        self.assertEqual(mapped[0], TranscriptSegment(121.2, 124.1, "테스트"))


class AudioBufferTests(unittest.IsolatedAsyncioTestCase):
    async def test_queue_overflow_drops_oldest_audio(self) -> None:
        buffer = BoundedAudioBuffer(sample_rate=10, max_seconds=2.0)
        buffer.append(bytes(range(60)))  # 30 samples, buffer can retain 20.
        self.assertAlmostEqual(buffer.dropped_seconds, 1.0)
        raw, start_sample = await buffer.pop(20)
        self.assertEqual(start_sample, 10)
        self.assertEqual(len(raw), 20)

    async def test_disconnect_close_unblocks_consumer(self) -> None:
        buffer = BoundedAudioBuffer(sample_rate=10, max_seconds=2.0)
        waiting = asyncio.create_task(buffer.pop(20))
        await asyncio.sleep(0)
        buffer.close()
        self.assertIsNone(await asyncio.wait_for(waiting, timeout=0.5))

    async def test_stop_restart_uses_fresh_timeline(self) -> None:
        first = BoundedAudioBuffer(sample_rate=10, max_seconds=2.0)
        first.append(bytes(20))
        self.assertEqual((await first.pop(20))[1], 0)
        first.close()

        restarted = BoundedAudioBuffer(sample_rate=10, max_seconds=2.0)
        restarted.append(bytes(20))
        self.assertEqual((await restarted.pop(20))[1], 0)

    async def test_graceful_stop_keeps_only_latest_backlog(self) -> None:
        buffer = BoundedAudioBuffer(sample_rate=10, max_seconds=10.0)
        buffer.append(bytes(160))  # 8 seconds
        buffer.keep_latest(2.0)
        raw, start_sample = await buffer.pop(40)
        self.assertEqual(len(raw), 40)
        self.assertEqual(start_sample, 60)
        self.assertAlmostEqual(buffer.dropped_seconds, 6.0)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import sys
import unittest
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from streaming import (  # noqa: E402
    LocalAgreement,
    SentenceAssembler,
    TranscriptSegment,
    Word,
    display_width,
    words_to_segment,
)


def seg(start: float, end: float, text: str) -> TranscriptSegment:
    return TranscriptSegment(start, end, text)


class SentenceAssemblerTests(unittest.TestCase):
    def test_fragments_are_joined_until_sentence_punctuation(self) -> None:
        assembler = SentenceAssembler()
        self.assertEqual(
            assembler.add([seg(0.0, 1.8, "오늘은 고정 소수점")], audio_end=4.0, next_start=2.0),
            [],
        )
        self.assertEqual(assembler.pending().text, "오늘은 고정 소수점")
        done = assembler.add(
            [seg(1.8, 3.6, "수 체계를 설명하겠습니다. 32비트")],
            audio_end=6.0,
            next_start=4.0,
        )
        self.assertEqual([item.text for item in done], ["오늘은 고정 소수점 수 체계를 설명하겠습니다."])
        self.assertAlmostEqual(done[0].start, 0.0)
        self.assertGreater(done[0].end, 1.8)
        self.assertLess(done[0].end, 3.6)
        self.assertEqual(assembler.pending().text, "32비트")

    def test_decimal_point_is_not_a_sentence_end(self) -> None:
        assembler = SentenceAssembler()
        assembler.add([seg(0.0, 2.0, "값은 3.14 정도입니다")], audio_end=4.0, next_start=2.1)
        self.assertEqual(assembler.pending().text, "값은 3.14 정도입니다")

    def test_pause_before_next_speech_ends_sentence(self) -> None:
        assembler = SentenceAssembler(pause_seconds=0.8)
        done = assembler.add([seg(0.0, 2.0, "이거 다 돈이에요")], audio_end=6.0, next_start=3.5)
        self.assertEqual([item.text for item in done], ["이거 다 돈이에요"])
        self.assertIsNone(assembler.pending())

    def test_gap_between_committed_fragments_ends_sentence(self) -> None:
        assembler = SentenceAssembler(pause_seconds=0.8)
        assembler.add([seg(0.0, 1.0, "첫 문장")], audio_end=4.0, next_start=1.2)
        done = assembler.add([seg(2.5, 3.0, "두 번째")], audio_end=6.0, next_start=3.1)
        self.assertEqual([item.text for item in done], ["첫 문장"])
        self.assertEqual(assembler.pending().text, "두 번째")

    def test_silence_without_new_speech_flushes_after_idle_time(self) -> None:
        assembler = SentenceAssembler(idle_flush_seconds=2.8)
        self.assertEqual(assembler.add([seg(0.0, 2.0, "말이 끝남")], audio_end=4.0), [])
        done = assembler.add([], audio_end=5.0)
        self.assertEqual([item.text for item in done], ["말이 끝남"])

    def test_long_sentence_is_split_at_a_space(self) -> None:
        assembler = SentenceAssembler(max_chars=20)
        done = assembler.add(
            [seg(0.0, 6.0, "픽스드 포인트와 플로팅 포인트는 정확도와 표현 범위에서 서로 다른")],
            audio_end=8.0,
            next_start=6.1,
        )
        self.assertTrue(done)
        self.assertTrue(all(display_width(item.text) <= 40 for item in done))
        joined = " ".join([item.text for item in done] + [assembler.pending().text])
        self.assertEqual(joined, "픽스드 포인트와 플로팅 포인트는 정확도와 표현 범위에서 서로 다른")

    def test_english_gets_twice_as_many_letters_before_a_forced_split(self) -> None:
        # Real-model case: an 84-letter English sentence was cut at 60
        # characters and translated as two broken halves.
        assembler = SentenceAssembler(max_chars=60)
        sentence = "The court ruled that he was not criminally liable because he acted in self-defense."
        done = assembler.add([seg(0.0, 5.0, sentence)], audio_end=7.0, next_start=5.1)
        self.assertEqual([item.text for item in done], [sentence])

    def test_flush_emits_unfinished_sentence(self) -> None:
        assembler = SentenceAssembler()
        assembler.add([seg(0.0, 1.0, "마지막 문장")], audio_end=2.0, next_start=1.1)
        self.assertEqual([item.text for item in assembler.flush()], ["마지막 문장"])
        self.assertEqual(assembler.flush(), [])


def words(*items: tuple[float, float, str]) -> list[Word]:
    return [Word(start, end, text) for start, end, text in items]


class LocalAgreementTests(unittest.TestCase):
    def test_commits_only_words_two_hypotheses_agree_on(self) -> None:
        agreement = LocalAgreement()
        first = words((0.0, 0.5, " 오늘은"), (0.5, 1.0, " 고정"), (1.0, 1.4, " 소수"))
        self.assertEqual(agreement.insert(first), [])
        self.assertEqual(len(agreement.provisional), 3)

        second = words(
            (0.0, 0.5, " 오늘은"), (0.5, 1.0, " 고정"), (1.0, 1.6, " 소수점"), (1.6, 2.0, " 수")
        )
        committed = agreement.insert(second)
        self.assertEqual(words_to_segment(committed).text, "오늘은 고정")
        self.assertEqual(words_to_segment(agreement.provisional).text, "소수점 수")
        self.assertAlmostEqual(agreement.committed_end, 1.0)

    def test_already_committed_words_are_not_committed_again(self) -> None:
        agreement = LocalAgreement()
        hypothesis = words((0.0, 0.5, " 안녕하세요"), (0.6, 1.0, " 여러분"))
        agreement.insert(hypothesis)
        agreement.insert(hypothesis)
        # The same audio is transcribed again with slightly shifted times.
        shifted = words(
            (0.05, 0.55, " 안녕하세요"), (0.62, 1.02, " 여러분"), (1.1, 1.5, " 오늘은")
        )
        self.assertEqual(agreement.insert(shifted), [])
        self.assertEqual(words_to_segment(agreement.provisional).text, "오늘은")

    def test_flush_commits_remaining_hypothesis(self) -> None:
        agreement = LocalAgreement()
        agreement.insert(words((0.0, 0.5, " 끝입니다.")))
        self.assertEqual(words_to_segment(agreement.flush()).text, "끝입니다.")
        self.assertEqual(agreement.provisional, [])


if __name__ == "__main__":
    unittest.main()

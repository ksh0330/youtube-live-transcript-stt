from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import server  # noqa: E402
from streaming import TranscriptSegment  # noqa: E402
from translator import needs_translation, nllb_code  # noqa: E402


class FakeTranslator:
    ready = True

    def __init__(self) -> None:
        self.calls = []

    def translate(self, texts, source, target="ko"):
        self.calls.append((list(texts), source, target))
        return [f"[{source}->{target}] {text}" for text in texts]


class LanguageCodeTests(unittest.TestCase):
    def test_whisper_codes_map_to_nllb(self) -> None:
        self.assertEqual(nllb_code("ja"), "jpn_Jpan")
        self.assertEqual(nllb_code("en"), "eng_Latn")
        self.assertIsNone(nllb_code("xx"))

    def test_translation_only_between_different_known_languages(self) -> None:
        self.assertTrue(needs_translation("ja", "ko"))
        self.assertFalse(needs_translation("ko", "ko"))
        self.assertFalse(needs_translation(None, "ko"))
        self.assertFalse(needs_translation("en", ""))
        self.assertFalse(needs_translation("xx", "ko"))


class AutoLanguageTests(unittest.TestCase):
    def test_auto_detects_until_a_confident_result_locks_it(self) -> None:
        config = {"language": "auto"}
        self.assertIsNone(server.session_language(config))
        server.remember_detection(config, {"language": "en", "probability": 0.55})
        self.assertIsNone(server.session_language(config))
        server.remember_detection(config, {"language": "ja", "probability": 0.93})
        self.assertEqual(server.session_language(config), "ja")
        # Once locked, a later detection does not flip it.
        server.remember_detection(config, {"language": "en", "probability": 0.99})
        self.assertEqual(server.session_language(config), "ja")

    def test_explicit_language_is_used_as_is(self) -> None:
        config = {"language": "en"}
        server.remember_detection(config, {"language": "ja", "probability": 0.99})
        self.assertEqual(server.session_language(config), "en")


class LocalizeUpdateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original = server.TRANSLATOR
        self.fake = FakeTranslator()
        server.TRANSLATOR = self.fake

    def tearDown(self) -> None:
        server.TRANSLATOR = self.original

    def run_localize(self, finalized, provisional, config, detected=None):
        return asyncio.run(
            server.localize_update(finalized, provisional, config, detected or {})
        )

    def test_sentences_and_current_sentence_are_translated(self) -> None:
        finals, provisional = self.run_localize(
            [TranscriptSegment(0.0, 2.0, "ご視聴ありがとうございました。")],
            [
                {"start": 2.0, "end": 3.0, "text": "今日は", "stable": True},
                {"start": 3.0, "end": 4.0, "text": "いい天気"},
            ],
            {"language": "ja", "translate_to": "ko"},
        )
        self.assertEqual(finals[0]["text"], "[ja->ko] ご視聴ありがとうございました。")
        self.assertEqual(finals[0]["original"], "ご視聴ありがとうございました。")
        self.assertEqual(len(provisional), 1)
        self.assertEqual(provisional[0]["text"], "[ja->ko] 今日は いい天気")
        self.assertEqual((provisional[0]["start"], provisional[0]["end"]), (2.0, 4.0))
        # One batched call per update.
        self.assertEqual(len(self.fake.calls), 1)

    def test_auto_language_uses_detected_source(self) -> None:
        finals, _ = self.run_localize(
            [TranscriptSegment(0.0, 1.0, "Thank you.")],
            [],
            {"language": "auto", "translate_to": "ko"},
            {"language": "en", "probability": 0.6},
        )
        self.assertEqual(finals[0]["text"], "[en->ko] Thank you.")

    def test_korean_speech_or_no_target_is_left_alone(self) -> None:
        for config in ({"language": "ko", "translate_to": "ko"}, {"language": "ja", "translate_to": ""}):
            finals, provisional = self.run_localize(
                [TranscriptSegment(0.0, 1.0, "그대로")],
                [{"start": 1.0, "end": 2.0, "text": "임시", "stable": True}],
                config,
            )
            self.assertEqual(finals, [{"start": 0.0, "end": 1.0, "text": "그대로"}])
            self.assertTrue(provisional[0]["stable"])
        self.assertEqual(self.fake.calls, [])

    def test_original_text_is_shown_while_the_model_loads(self) -> None:
        self.fake.ready = False
        finals, _ = self.run_localize(
            [TranscriptSegment(0.0, 1.0, "Hello.")], [], {"language": "en", "translate_to": "ko"}
        )
        self.assertEqual(finals[0]["text"], "Hello.")
        self.assertNotIn("original", finals[0])
        self.assertEqual(self.fake.calls, [])

    def test_translation_failure_falls_back_to_original_text(self) -> None:
        class Broken:
            ready = True

            def translate(self, *_args, **_kwargs):
                raise RuntimeError("model download failed")

        server.TRANSLATOR = Broken()
        finals, _ = self.run_localize(
            [TranscriptSegment(0.0, 1.0, "Hello.")], [], {"language": "en", "translate_to": "ko"}
        )
        self.assertEqual(finals[0]["text"], "Hello.")
        self.assertIn("model download failed", server.TRANSLATION_ERROR)
        server.TRANSLATION_ERROR = None


if __name__ == "__main__":
    unittest.main()

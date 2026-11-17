"""Local sentence translation with NLLB-200 on CTranslate2.

Whisper's own translate task only produces English, so Korean subtitles for
English or Japanese speech need a separate model. NLLB-200 runs on the same
CTranslate2 engine as faster-whisper, and its tokenizer.json is read with the
`tokenizers` package that faster-whisper already installs.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Iterable

log = logging.getLogger("yt-live-stt")

DEFAULT_TRANSLATION_MODEL = "OpenNMT/nllb-200-distilled-1.3B-ct2-int8"

# Whisper language code -> NLLB-200 (FLORES-200) code.
NLLB_CODES = {
    "ko": "kor_Hang",
    "en": "eng_Latn",
    "ja": "jpn_Jpan",
    "zh": "zho_Hans",
    "es": "spa_Latn",
    "fr": "fra_Latn",
    "de": "deu_Latn",
    "it": "ita_Latn",
    "pt": "por_Latn",
    "ru": "rus_Cyrl",
    "vi": "vie_Latn",
    "th": "tha_Thai",
    "id": "ind_Latn",
    "ar": "arb_Arab",
    "hi": "hin_Deva",
}


def nllb_code(language: str | None) -> str | None:
    return NLLB_CODES.get(str(language or "").lower().split("-")[0])


def needs_translation(source: str | None, target: str | None) -> bool:
    """Translate only between two different languages that NLLB knows."""
    if not source or not target:
        return False
    source_code, target_code = nllb_code(source), nllb_code(target)
    return bool(source_code and target_code and source_code != target_code)


class SentenceTranslator:
    """Lazy-loaded NLLB translator. Loading happens on first use."""

    def __init__(self, model: str = DEFAULT_TRANSLATION_MODEL, device: str = "cpu") -> None:
        self.model = model
        self.device = device
        self._translator = None
        self._tokenizer = None
        self._lock = threading.Lock()

    @property
    def ready(self) -> bool:
        return self._translator is not None

    def preload(self) -> None:
        """Load (and on first use download) the model ahead of the first
        sentence, so the live transcript never waits for it."""
        with self._lock:
            self._load()

    def _load(self) -> None:
        if self._translator is not None:
            return
        import ctranslate2
        from huggingface_hub import snapshot_download
        from tokenizers import Tokenizer

        path = Path(self.model)
        model_dir = path if path.exists() else Path(snapshot_download(self.model))
        compute = "int8_float16" if self.device == "cuda" else "int8"
        log.info("Translation model loading: %s / %s / %s", self.model, self.device, compute)
        self._translator = ctranslate2.Translator(
            str(model_dir), device=self.device, compute_type=compute
        )
        self._tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        log.info("Translation model ready")

    def translate(
        self, texts: Iterable[str], source: str, target: str = "ko"
    ) -> list[str]:
        texts = [str(text or "").strip() for text in texts]
        if not any(texts) or not needs_translation(source, target):
            return texts
        with self._lock:
            self._load()
            source_code, target_code = nllb_code(source), nllb_code(target)
            batch = [
                [source_code]
                + self._tokenizer.encode(text, add_special_tokens=False).tokens
                + ["</s>"]
                for text in texts
            ]
            results = self._translator.translate_batch(
                batch,
                target_prefix=[[target_code]] * len(batch),
                beam_size=2,
                max_decoding_length=256,
            )
        output = []
        for text, result in zip(texts, results):
            tokens = result.hypotheses[0][1:] if result.hypotheses else []
            ids = [self._tokenizer.token_to_id(token) for token in tokens]
            translated = self._tokenizer.decode(
                [token_id for token_id in ids if token_id is not None],
                skip_special_tokens=True,
            ).strip()
            output.append(translated or text)
        return output

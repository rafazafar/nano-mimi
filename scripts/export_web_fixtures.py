"""Export golden fixtures for the browser port from the real Python functions.

Runs the production code over the corpus in ``web_fixture_corpus.py`` and writes
input -> output JSON under ``web/fixtures/core`` (one file per function family)
and ``web/fixtures/vad``. Output is deterministic: sorted keys, stable case order.

    uv run python scripts/export_web_fixtures.py

Needs the CAT tokenizer in the Hugging Face cache (``hotchpotch/CAT-Translate-1.4b-mlx-q4``)
and, for the VAD fixtures, the WAVs from ``make fixture``. macOS only (MLX).
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import wave
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

import web_fixture_corpus as corpus  # noqa: E402

import mimivox.config as config  # noqa: E402
from mimivox import asr, number_check, revision, translate  # noqa: E402
from mimivox.config import CAT_MODEL_ID, CONTEXT_TURNS, SAMPLE_RATE, _models  # noqa: E402
from mimivox.vad import _WIN, SileroOnnx, SileroVAD  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "web" / "fixtures"
WAV_DIR = ROOT / "data" / "fixtures"
VAD_WAVS = ("meeting-recording.wav", "meeting-recording-split.wav")

_INLINE_MAX = 100


# ---------------------------------------------------------------------------
# Deterministic JSON
# ---------------------------------------------------------------------------
def _scalar(v: Any) -> bool:
    return not isinstance(v, (dict, list))


def _flat(v: Any) -> bool:
    return isinstance(v, list) and all(_scalar(x) or _flat(x) for x in v)


def _inline(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(", ", ": "))


def render(v: Any, indent: int = 0) -> str:
    """Pretty JSON that keeps scalar lists and short containers on one line."""
    if _scalar(v) or _flat(v) or len(_inline(v)) <= _INLINE_MAX:
        return _inline(v)
    pad, inner = "  " * indent, "  " * (indent + 1)
    if isinstance(v, dict):
        items = [
            f"{inner}{json.dumps(k, ensure_ascii=False)}: {render(v[k], indent + 1)}"
            for k in sorted(v)
        ]
        return "{\n" + ",\n".join(items) + f"\n{pad}}}"
    return "[\n" + ",\n".join(f"{inner}{render(x, indent + 1)}" for x in v) + f"\n{pad}]"


def write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render(obj) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Core families
# ---------------------------------------------------------------------------
def cases(inputs: list[Any], fn: Any) -> list[dict[str, Any]]:
    return [{"input": i, "output": fn(i)} for i in inputs]


def family(name: str, functions: dict[str, list[dict[str, Any]]]) -> None:
    write_json(FIXTURES / "core" / f"{name}.json", {"family": name, "functions": functions})


def ctx(pairs: list[Any]) -> list[tuple[str, str]]:
    return [(ja, en) for ja, en in pairs]


def cat_tokenizer() -> tuple[Any, str]:
    from huggingface_hub import snapshot_download
    from mlx_lm.tokenizer_utils import load as load_tokenizer

    path = Path(snapshot_download(CAT_MODEL_ID, local_files_only=True))
    return load_tokenizer(path), path.name


def export_core() -> None:
    family(
        "text",
        {
            "normalize_punctuation": cases(
                corpus.NORMALIZE_PUNCTUATION, translate.normalize_punctuation
            ),
            "is_non_content_asr": cases(corpus.IS_NON_CONTENT_ASR, asr.is_non_content_asr),
            "deduplicate_phrases": cases(corpus.DEDUPLICATE_PHRASES, asr._deduplicate_phrases),
            "is_mostly_english": cases(corpus.IS_MOSTLY_ENGLISH, translate._is_mostly_english),
        },
    )
    family(
        "glossary",
        {
            "apply_glossary": cases(
                corpus.APPLY_GLOSSARY,
                lambda c: translate.apply_glossary(c["text"], dict(c["glossary"])),
            )
        },
    )
    family(
        "revision",
        {
            "ends_mid_sentence": cases(corpus.ENDS_MID_SENTENCE, revision.ends_mid_sentence),
            "is_split_continuation": cases(
                [{"prev": p, "next": n, "gap_s": g} for p, n, g in corpus.IS_SPLIT_CONTINUATION],
                lambda c: revision.is_split_continuation(c["prev"], c["next"], c["gap_s"]),
            ),
        },
    )
    family(
        "numbers",
        {
            "unsupported_numbers": cases(
                [{"ja": ja, "en": en} for ja, en in corpus.UNSUPPORTED_NUMBERS],
                lambda c: number_check.unsupported_numbers(c["ja"], c["en"]),
            ),
            "group_digits": cases(corpus.GROUP_DIGITS, number_check.group_digits),
        },
    )
    family(
        "clean",
        {
            "clean_cat": cases(
                corpus.CLEAN_CAT,
                lambda raw: dict(
                    zip(("text", "prompt_leak", "japanese_stripped"), translate._clean_cat(raw))
                ),
            ),
            "echoes_context": cases(
                [{"en": en, "context": c, "ja": ja} for en, c, ja in corpus.ECHOES_CONTEXT],
                lambda c: translate._echoes_context(c["en"], ctx(c["context"]), c["ja"]),
            ),
            "too_short": cases(
                [{"en": en, "ja": ja} for en, ja in corpus.TOO_SHORT],
                lambda c: translate._too_short(c["en"], c["ja"]),
            ),
        },
    )

    tokenizer, snapshot = cat_tokenizer()

    def render_chat(c: dict[str, Any]) -> dict[str, Any]:
        messages, max_tokens = translate._chat_messages(c["ja"], ctx(c["context"]))
        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        return {"messages": messages, "max_tokens": max_tokens, "prompt": prompt}

    def context_after(adds: list[Any]) -> list[Any]:
        context = translate.TranslationContext()
        for ja, en in adds:
            context.add(ja, en)
        return [list(p) for p in context.pairs()]

    family(
        "prompt",
        {
            "prompt_and_tokens": cases(
                corpus.PROMPT_AND_TOKENS,
                lambda ja: dict(zip(("prompt", "max_tokens"), translate._prompt_and_tokens(ja))),
            ),
            "chat_messages": cases(corpus.CHAT_MESSAGES, render_chat),
        },
    )
    family(
        "context",
        {
            "context_turns": [{"input": None, "output": CONTEXT_TURNS}],
            "translation_context": cases(corpus.CONTEXT_ADDS, context_after),
        },
    )
    seeds = dict(config._TRANSLATION_CACHE_SEEDS)
    family(
        "cache",
        {
            "cache_key": cases(corpus.CACHE_KEY, translate.translation_cache_key),
            "pipeline_cache_key": cases(
                corpus.PIPELINE_CACHE_KEY,
                lambda c: translate.translation_cache_key(
                    translate.apply_glossary(
                        translate.normalize_punctuation(c["ja"]), dict(c["glossary"])
                    )
                ),
            ),
            "seeds": [{"input": k, "output": v} for k, v in sorted(seeds.items())],
        },
    )

    vocab = tokenizer.get_vocab()
    ids = translate.japanese_token_ids(vocab)
    write_json(
        FIXTURES / "core" / "tokens.json",
        {
            "family": "tokens",
            "functions": {
                "japanese_token_ids": cases(
                    corpus.JAPANESE_TOKEN_VOCABS, translate.japanese_token_ids
                ),
            },
            "cat": {
                "model": CAT_MODEL_ID,
                "snapshot": snapshot,
                "vocab_size": len(vocab),
                "japanese_token_ids": ids,
            },
        },
    )


# ---------------------------------------------------------------------------
# VAD
# ---------------------------------------------------------------------------
class RecordingModel:
    """Wraps a Silero model, recording the probability of each 512-sample window."""

    def __init__(self, model: Any) -> None:
        self._model = model
        self.probs: list[float] = []
        self.calls = 0

    def __call__(self, win: np.ndarray) -> float:
        p = self._model(win)
        self.calls += 1
        self.probs.append(round(float(p), 6))
        return p

    def reset_states(self) -> None:
        self._model.reset_states()


class ScriptedModel:
    """Replays a probability per window, as tests/test_vad.py's fake does."""

    def __init__(self, probs: list[float]) -> None:
        self._probs = probs
        self.calls = 0
        self._i = 0

    def __call__(self, win: np.ndarray) -> float:
        p = self._probs[self._i] if self._i < len(self._probs) else 0.0
        self._i += 1
        self.calls += 1
        return p

    def reset_states(self) -> None:
        pass


class LocatingVAD(SileroVAD):
    """SileroVAD that records where in the input each candidate utterance sat.

    ``_emit`` receives the raw slice of the input before gain and trimming, so
    it is located by exact match in the window range where it must end.
    """

    _SEARCH_WINDOWS = 64

    def __init__(self, audio: np.ndarray, model: RecordingModel | ScriptedModel) -> None:
        _models.silero = model
        super().__init__()
        self._audio = audio
        self._model_calls = model
        self.utterances: list[dict[str, Any]] = []

    def _locate(self, chunk: np.ndarray) -> int:
        hi = self._model_calls.calls * _WIN - chunk.size
        for start in range(hi, max(hi - self._SEARCH_WINDOWS * _WIN, -1), -1):
            seg = self._audio[start : start + chunk.size]
            if seg.size == chunk.size and np.array_equal(seg, chunk):
                return start
        raise RuntimeError("emitted chunk is not a slice of the input near the stream position")

    def _emit(self, chunk: np.ndarray) -> np.ndarray | None:
        start = self._locate(chunk)
        out = super()._emit(chunk)
        self.utterances.append(
            {
                "start": start,
                "end": start + chunk.size,
                "emitted": out is not None,
                "emitted_samples": 0 if out is None else int(out.size),
            }
        )
        return out


def run_vad(
    audio: np.ndarray, model: RecordingModel | ScriptedModel, slice_size: int
) -> dict[str, Any]:
    vad = LocatingVAD(audio, model)
    waits: list[float] = []
    for i in range(0, audio.size, slice_size):
        if vad.feed(audio[i : i + slice_size]):
            waits.extend(round(w, 6) for w in vad.last_emits_vad_wait)
    vad.flush()
    return {"utterances": vad.utterances, "vad_wait_s": waits}


def tuning() -> dict[str, Any]:
    return {
        "threshold": config.VAD_THRESHOLD,
        "min_silence_ms": config.VAD_MIN_SILENCE_MS,
        "speech_pad_ms": config.VAD_SPEECH_PAD_MS,
        "min_speech_ms": config.VAD_MIN_SPEECH_MS,
        "min_speech_s": config.MIN_SPEECH_S,
        "max_emit_s": config.MAX_EMIT_S,
    }


def scripted_audio(script: list[list[float]]) -> tuple[np.ndarray, list[float]]:
    """``[windows, prob, amplitude]`` segments -> (audio, per-window probs)."""
    probs = [p for n, p, _ in script for _ in range(int(n))]
    audio = np.concatenate([np.full(int(n) * _WIN, a, dtype=np.float32) for n, _, a in script])
    return audio, probs


_WPS = SAMPLE_RATE // _WIN
SCRIPTED = {
    "pure_silence": [[200, 0.0, 0.0]],
    "single_utterance": [[2 * _WPS, 1.0, 0.5], [2 * _WPS, 0.0, 0.0]],
    "two_utterances": [
        [2 * _WPS, 1.0, 0.5],
        [_WPS, 0.0, 0.0],
        [2 * _WPS, 1.0, 0.5],
        [_WPS, 0.0, 0.0],
    ],
    "short_pause_does_not_split": [
        [2 * _WPS, 1.0, 0.5],
        [int(0.3 * _WPS), 0.0, 0.0],
        [2 * _WPS, 1.0, 0.5],
        [_WPS, 0.0, 0.0],
    ],
    "onset_pad": [[int(0.5 * _WPS), 0.0, 0.0], [2 * _WPS, 1.0, 0.5], [int(1.2 * _WPS), 0.0, 0.0]],
    "too_short_dropped": [[1, 1.0, 0.5], [_WPS, 0.0, 0.0]],
    "flush_at_end_of_stream": [[4, 0.0, 0.0], [2 * _WPS, 1.0, 0.5]],
    "quiet_speaker_raised": [[_WPS, 0.0, 0.0], [2 * _WPS, 1.0, 0.0014], [_WPS, 0.0, 0.0]],
    "below_absolute_floor": [[_WPS, 0.0, 0.0], [2 * _WPS, 1.0, 0.00014], [_WPS, 0.0, 0.0]],
    "loud_speaker_not_attenuated": [[_WPS, 0.0, 0.0], [2 * _WPS, 1.0, 0.8], [_WPS, 0.0, 0.0]],
    "max_emit_split": [[_WPS, 0.0, 0.0], [600, 1.0, 0.5], [2 * _WPS, 0.0, 0.0]],
    "threshold_edge": [[_WPS, 0.0, 0.0], [20, 0.35, 0.5], [20, 0.3499, 0.5], [2 * _WPS, 0.0, 0.0]],
    "speech_under_min_open": [[_WPS, 0.0, 0.0], [7, 1.0, 0.5], [_WPS, 0.0, 0.0]],
}
SLICE_SIZES = (1, 7, 512, 4096)


def export_vad() -> None:
    config.apply_latency_quality("fast")
    config.apply_live_vad_overrides()
    settings = tuning()
    script_cases = []
    for name, script in SCRIPTED.items():
        audio, probs = scripted_audio(script)
        results = [run_vad(audio, ScriptedModel(probs), s) for s in SLICE_SIZES]
        if any(r != results[0] for r in results):
            raise RuntimeError(f"VAD output depends on feed slicing for {name!r}")
        script_cases.append({"name": name, "input": {"script": script}, "output": results[0]})
    write_json(FIXTURES / "vad" / "scripted.json", {"tuning": settings, "cases": script_cases})

    for wav_name in VAD_WAVS:
        path = WAV_DIR / wav_name
        if not path.exists():
            subprocess.run(["make", "fixture"], cwd=ROOT, check=True)
            subprocess.run(
                [sys.executable, "scripts/make_meeting_fixture.py", "--split"], cwd=ROOT, check=True
            )
        with wave.open(str(path)) as w:
            assert w.getframerate() == SAMPLE_RATE and w.getnchannels() == 1
            audio = (
                np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
                / 32768.0
            )
        model = RecordingModel(SileroOnnx())
        result = run_vad(audio, model, 1 << 30)
        write_json(
            FIXTURES / "vad" / f"{path.stem}.json",
            {
                "wav": {
                    "name": wav_name,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "samples": int(audio.size),
                },
                "tuning": settings,
                "window_probs": model.probs,
                **result,
            },
        )


def main() -> None:
    export_core()
    export_vad()


if __name__ == "__main__":
    main()

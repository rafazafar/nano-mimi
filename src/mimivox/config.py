"""mimivox.config — Global constants, model configuration, and shared state."""

from __future__ import annotations

import asyncio
import collections
import dataclasses
import os
import re
import weakref
from typing import Any, Literal

# ---------------------------------------------------------------------------
# Model IDs
# ---------------------------------------------------------------------------
# Default recognizer for every source language except Japanese, and for dictation.
WHISPER_MODEL = "LibraxisAI/whisper-large-v3-turbo-mlx-q8"
# Default recognizer for Japanese source sessions (Japanese-only FastConformer-TDT).
HAAS_JA_MODEL = "basyauma-tech/Haas-ja-v1.0-mlx-8bit"
CAT_MODEL_ID = "hotchpotch/CAT-Translate-1.4b-mlx-q4"

# ---------------------------------------------------------------------------
# Audio parameters
# ---------------------------------------------------------------------------
SAMPLE_RATE = 16_000
MIN_SPEECH_S = 0.6  # filter filler chunks (はい, えー) that bloat count
MAX_CHUNK_S = 15

# ---------------------------------------------------------------------------
# Silero VAD tuning
# ---------------------------------------------------------------------------
# Silence close must sit above typical Japanese intra-sentence pauses (~300–500ms).
VAD_THRESHOLD = 0.35  # quieter mobile-speaker→room→mic still opens utterances
VAD_MIN_SILENCE_MS = 700  # was 500 — too eager to split JP dialogue
VAD_SPEECH_PAD_MS = 120  # onset/offset pad applied by SileroVAD
VAD_MIN_SPEECH_MS = 250  # consecutive speech before opening an utterance
MAX_EMIT_S = 15.0  # hard cap per emitted ASR chunk

# Snapshot of factory defaults so latency presets can restore cleanly.
_LATENCY_DEFAULTS: dict[str, Any] = {
    "MIN_SPEECH_S": MIN_SPEECH_S,
    "MAX_CHUNK_S": MAX_CHUNK_S,
    "VAD_THRESHOLD": VAD_THRESHOLD,
    "VAD_MIN_SILENCE_MS": VAD_MIN_SILENCE_MS,
    "MAX_EMIT_S": MAX_EMIT_S,
}

# Latency quality presets applied at session start only (not mid-stream).
# "fast" == current production defaults.
LATENCY_PRESETS: dict[str, dict[str, Any]] = {
    "fast": {
        "MIN_SPEECH_S": 0.6,
        "MAX_CHUNK_S": 15,
        "VAD_THRESHOLD": 0.35,
        "VAD_MIN_SILENCE_MS": 700,
        "MAX_EMIT_S": 15.0,
    },
    "balanced": {
        "MIN_SPEECH_S": 0.7,
        "MAX_CHUNK_S": 18,
        "VAD_THRESHOLD": 0.32,
        "VAD_MIN_SILENCE_MS": 850,
        "MAX_EMIT_S": 18.0,
    },
    "quality": {
        "MIN_SPEECH_S": 0.8,
        "MAX_CHUNK_S": 22,
        "VAD_THRESHOLD": 0.28,
        "VAD_MIN_SILENCE_MS": 1000,
        "MAX_EMIT_S": 22.0,
    },
}


# ---------------------------------------------------------------------------
# Caption confidence thresholds (see mimivox.confidence)
# ---------------------------------------------------------------------------
# ASR: duration-weighted mean token logprob over Whisper segments (Whisper's
# own fallback cutoff is -1.0), worst-segment no_speech_prob and
# compression_ratio. MT: mean logprob of the tokens CAT sampled. Each pair is
# (medium_below, low_below) for logprobs and (medium_above, low_above) for the
# rest. Calibrated with scripts/confidence_report.py (numbers in the PR).
CONF_ASR_LOGPROB = (-0.36, -0.8)
CONF_NO_SPEECH = (0.3, 0.6)
CONF_COMPRESSION = (2.0, 2.4)
CONF_MT_LOGPROB = (-0.4, -0.8)

# ---------------------------------------------------------------------------
# Live-specific VAD overrides
# ---------------------------------------------------------------------------
# The presets above favor accuracy (longer silence close avoids splitting JP
# dialogue). For live mic we trade a little splitting for lower perceived
# latency — the silence close is endpointing delay the user feels.
LIVE_VAD_MIN_SILENCE_MS = 400
LIVE_VAD_SPEECH_PAD_MS = 80
# Cap live ASR chunks so long monologues don't sit in one 13–15s Whisper pass.
# File/replay keeps the latency-preset MAX_EMIT_S (accuracy over split rate).
# Whisper has high fixed per-call overhead. A clause-sized emergency cap keeps
# continuous speech bounded without turning one sentence into many slow calls.
LIVE_MAX_EMIT_S = 15.0

# ---------------------------------------------------------------------------
# Live ASR queue policy (no accuracy change when queue is empty)
# ---------------------------------------------------------------------------
# Hard cap on asr_q. Live path also enforces ASR_Q_LIVE_KEEP (stricter).
ASR_Q_MAXSIZE = 4
# Live enqueue: drop oldest until fewer than this many items are waiting,
# then put the new utterance. KEEP=1 ⇒ at most one pending decode while ASR
# is busy — prevents the 6–17s backlog death-spiral seen on FamilyLife bursts.
# File/replay never uses this (blocking put, no drops).
ASR_Q_LIVE_KEEP = 1
# Dequeue-side: if an item already waited this long and more audio is pending,
# skip it rather than spending another full decode on outdated speech.
ASR_Q_STALE_WAIT_S = 0.9

HEALTH_BEHIND_S = 4.0
HEALTH_BEHIND_CLEAR_S = 2.0
HEALTH_OVERLOADED_S = 10.0
HEALTH_OVERLOADED_CLEAR_S = 6.0


def apply_live_vad_overrides() -> None:
    """Tighten VAD endpointing + emit cap for live sessions.

    Call after apply_latency_quality. Mutates silence-close, onset/offset pad,
    and MAX_EMIT_S (hard split during continuous speech). Other preset gates
    (min-speech, threshold) stay on the chosen latency_quality mode.
    """
    global VAD_MIN_SILENCE_MS, VAD_SPEECH_PAD_MS, MAX_EMIT_S
    VAD_MIN_SILENCE_MS = LIVE_VAD_MIN_SILENCE_MS
    VAD_SPEECH_PAD_MS = LIVE_VAD_SPEECH_PAD_MS
    MAX_EMIT_S = LIVE_MAX_EMIT_S


def apply_latency_quality(mode: str) -> str:
    """Apply VAD/chunk tuning for the given latency mode.

    Mutates module-level tuning constants. Call only at session start.
    Unknown modes fall back to ``fast``. Returns the mode actually applied.
    """
    global MIN_SPEECH_S, MAX_CHUNK_S, VAD_THRESHOLD, VAD_MIN_SILENCE_MS, MAX_EMIT_S
    key = (mode or "fast").strip().lower()
    preset = LATENCY_PRESETS.get(key) or LATENCY_PRESETS["fast"]
    applied = key if key in LATENCY_PRESETS else "fast"
    MIN_SPEECH_S = float(preset["MIN_SPEECH_S"])
    MAX_CHUNK_S = int(preset["MAX_CHUNK_S"])
    VAD_THRESHOLD = float(preset["VAD_THRESHOLD"])
    VAD_MIN_SILENCE_MS = int(preset["VAD_MIN_SILENCE_MS"])
    MAX_EMIT_S = float(preset["MAX_EMIT_S"])
    return applied


def latency_tuning_snapshot() -> dict[str, Any]:
    """Current VAD/chunk constants (for tests and diagnostics)."""
    return {
        "MIN_SPEECH_S": MIN_SPEECH_S,
        "MAX_CHUNK_S": MAX_CHUNK_S,
        "VAD_THRESHOLD": VAD_THRESHOLD,
        "VAD_MIN_SILENCE_MS": VAD_MIN_SILENCE_MS,
        "MAX_EMIT_S": MAX_EMIT_S,
    }


# ---------------------------------------------------------------------------
# Translation cache
# ---------------------------------------------------------------------------
_TRANSLATION_CACHE: collections.OrderedDict[str, str] = collections.OrderedDict()
_TRANSLATION_CACHE_MAX = 256
# MtSignals (mimivox.confidence) of each cached translation, same keys, so a
# cache hit keeps the confidence of the CAT run that produced it.
_MT_SIGNALS_CACHE: collections.OrderedDict[str, Any] = collections.OrderedDict()

# Caption revision: a final that stops mid-sentence is merged with the next one
# when that starts within this gap. The VAD splits only after VAD_MIN_SILENCE_MS
# (700 ms default, up to 1000 ms in the slowest preset) plus pad, so 1.5 s covers
# every preset's split pause while a new topic after a real beat stays separate.
REVISION_MAX_GAP_S = 1.5
# Do not keep joining a run-on past this many JA characters.
REVISION_MAX_JOINED_CHARS = 120

# Prior (JA, EN) lines shown to CAT so it can resolve dropped subjects/objects.
CONTEXT_TURNS = 3

# Seed phrases kept separately so A/B runs can reset runtime cache hits
# without losing the built-in opener/filler shortcuts.
_TRANSLATION_CACHE_SEEDS: dict[str, str] = {
    # Kinship / address terms
    "お兄ちゃん。": "Big brother.",
    "お兄ちゃん、がんばって！": "Come on, big brother!",
    "お兄ちゃん、がんばって!": "Come on, big brother!",
    "お兄ちゃん、えらーい!": "Wow, big brother!",
    "お父さん。": "Dad.",
    "お母さん。": "Mom.",
    # Greetings & stock phrases
    "おはよう。": "Good morning.",
    "おはよう!": "Good morning!",
    "はーい。": "Yes!",
    "はい。": "Yes.",
    "ありがとう。": "Thank you.",
    "ありがとうございました。": "Thank you very much.",
    "おやすみ。": "Good night.",
    "おやすみなさい。": "Good night.",
    "いいよ。": "Okay.",
    "わかった。": "Understood.",
    "いただきます。": "Let me begin.",
    # Business meeting opener
    "では始めさせていただきます。": "Let me begin.",
    "ごちそうさま。": "Thanks for the meal.",
    "ごちそうさまでした。": "Thanks for the meal.",
    # Filler / minimal utterances
    "ん。": "Mm.",
    "競争?": "Competition?",
    "競争。": "Competition.",
    # Corrections & apologies
    "頑張りなさい。": "Do your best!",
    "ごめんなさい。": "I'm sorry.",
    "ごめんごめん。": "Sorry, sorry.",
    # Single-word food/item names
    "豚肉。": "Pork.",
    "カレー大好き!": "I love curry!",
    # Fragment subject phrases
    "ほのかは。": "Honoka,",
    # Action fragments
    "先に入る。": "I'll go first.",
    # Competitive exclamation
    "お父さん、俺の方が早い!": "Dad, I'm faster!",
}
_TRANSLATION_CACHE.update(_TRANSLATION_CACHE_SEEDS)


def reset_translation_cache() -> None:
    """Drop runtime CAT hits; restore built-in seed phrases only."""
    _TRANSLATION_CACHE.clear()
    _MT_SIGNALS_CACHE.clear()
    _TRANSLATION_CACHE.update(_TRANSLATION_CACHE_SEEDS)


# ---------------------------------------------------------------------------
# Glossary
# ---------------------------------------------------------------------------
GLOSSARY: dict[str, str] = {
    "てっこうです": "結構です",
    "てっこう": "結構",
}

# ---------------------------------------------------------------------------
# Prompt leak markers
# ---------------------------------------------------------------------------
_PROMPT_LEAK_MARKERS = [
    "Translate the following",
    "Please translate",
    "The meaning, tone",
    "Preserve the meaning",
    "avoid stiff literal",
    "avoid overly rigid",
    "Avoid using overly rigid",
    "Avoid using overly formal",
    "Avoid overly formal",
    "Avoid overly literal",
    "speaker intent",
    "can be translated",
    "has been translated",
    "Please keep the meaning",
    "Please preserve",
    "natural conversational English",
    "Your message",
    "message has been",
    "Translate to English",
    "following Japanese",
    "in Japanese",
    "In English,",
    "Let's keep playing",
    "speak English naturally",
    "I'll help you speak",
    "I'll help you",
    "I can help you",
    "that was incorrect",
    "This Japanese phrase",
    "correct translation:",
    "ccenture",
    "Here is the instruction",
    "English:",
    "this phrase in English",
    "Japanese:",
    "Please use the",
]

_PROMPT_SUFFIX_RE = re.compile(r"[.\s]?English:\s*$")

# ---------------------------------------------------------------------------
# Regex patterns
# ---------------------------------------------------------------------------
_SEG_RE = re.compile(r"^\[\d+:\d+\.\d+ --> \d+:\d+\.\d+\]\s+(.+)")
_JAPANESE_RE = re.compile(r"[぀-ヿ一-鿿㐀-䶿･-ﾟ]")

# ---------------------------------------------------------------------------
# Prompt templates
# ---------------------------------------------------------------------------
_ULTRA_SHORT_PROMPT = "Japanese: {ja}\nEnglish:"
_SHORT_PHRASE_PROMPT = "Translate this Japanese phrase to natural English: {ja}"
_LONG_PHRASE_PROMPT = (
    "Translate the following Japanese speech into natural conversational English. "
    "Preserve the meaning, tone, and speaker intent; avoid stiff literal wording.\n\n{ja}"
)

# Instruct LLM for meeting notes / Ask (lazy-loaded, optional download).
NOTES_MODEL_ID = (
    os.environ.get("MIMIVOX_NOTES_MODEL") or "mlx-community/Qwen3-4B-Instruct-2507-4bit"
)


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------
@dataclasses.dataclass
class ASRResult:
    kind: Literal["partial", "final"]
    text: str  # JA text
    audio_ts: str  # "MM:SS" label for console
    wall_time: str  # HH:MM:SS wall clock
    asr_latency: float  # seconds
    partial_text: str = ""  # set on the *final* result for log comparison
    duration_s: float | None = None  # utterance length in seconds (optional)
    timeline_s: float = 0.0  # audio-origin seconds (for UI timestamps)
    # Endpointing + queue diagnostics (seconds). vad_wait = silence-close
    # time the VAD held the utterance before emitting; queue_wait = time the
    # utterance sat in asr_q before the ASR worker picked it up.
    vad_wait_s: float = 0.0
    queue_wait_s: float = 0.0
    # {"id", "label"} from the speaker tracker; None when unavailable.
    speaker: dict[str, str] | None = None
    speaker_ms: float = 0.0  # embedding latency for this utterance
    asr_signals: Any = None  # mimivox.confidence.AsrSignals for finals
    skip_translation: bool = False


@dataclasses.dataclass
class _ModelState:
    cat_model: Any = None
    cat_tokenizer: Any = None
    # Token ids CAT may not emit in English output (kana, kanji, CJK
    # punctuation and their UTF-8 lead bytes); an mx.array set at load.
    cat_banned_ids: Any = None
    silero: Any = None
    # The runtime assigns one shared lock to both paths. Concurrent Whisper/CAT
    # inference causes severe Metal and unified-memory contention on 16 GB Macs.
    asr_lock: Any = None  # asyncio.Lock set at runtime
    cat_lock: Any = None  # asyncio.Lock set at runtime
    # >0 while a final translation is waiting on / holding cat_lock. Preview
    # partial-EN bails so it cannot start (or re-enter) ahead of the final.
    cat_final_waiting: int = 0


_models = _ModelState()


# The event loop each shared lock was made on; an asyncio.Lock cannot cross loops.
_LOCK_LOOPS: weakref.WeakKeyDictionary[asyncio.Lock, asyncio.AbstractEventLoop] = (
    weakref.WeakKeyDictionary()
)


def shared_mlx_lock() -> asyncio.Lock:
    """Return the one lock ASR and CAT share on the running event loop.

    Sessions, notes, dictation, and translation all take this lock, so a
    session that starts while a notes call holds it waits instead of running
    Whisper beside the notes LLM. A new event loop (each CLI run) gets a new lock.
    """
    loop = asyncio.get_running_loop()
    lock = _models.asr_lock
    if lock is None or _LOCK_LOOPS.setdefault(lock, loop) is not loop:
        lock = _models.asr_lock = asyncio.Lock()
        _LOCK_LOOPS[lock] = loop
    _models.cat_lock = lock
    return lock


# ---------------------------------------------------------------------------
# Base data directory for runtime outputs
# ---------------------------------------------------------------------------
# Override with MIMIVOX_DATA_DIR (the macOS app bundle sets it to
# ~/Library/Application Support/MimiVox). Default stays cwd-relative.
DATA_DIR = os.environ.get("MIMIVOX_DATA_DIR") or "data"

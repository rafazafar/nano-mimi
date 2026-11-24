"""Export the browser ASR's parity fixtures and bench clips from the Python reference.

Needs the files ``scripts/build_web_asr_models.py`` staged under ``web/.models`` and the
FLEURS cache (``scripts/eval/fetch_fleurs.py``).

- ``web/fixtures/asr/`` (committed): the JS front end's tables, one clip's audio and its
  haas_ja_local log-mel, and for three clips an encoder output (fp16 encoder on ORT CPU,
  rounded to fp16) with the token ids and text haas_ja_local's greedy TDT decodes from it
  on the fp32 decoder_joint.
- ``web/.bench/`` (ignored): the 100 S0b clips (FLEURS ja_jp dev, one recording per
  sentence id, ids sorted, first 100) as float32 PCM after run_eval's RMS levelling and
  ``_trim_trailing_silence``, plus ``clips.json`` with the references.

    uv run python scripts/export_asr_web_fixtures.py
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
import onnxruntime as ort
from haas_ja_local.config import HaasConfig
from haas_ja_local.decode import greedy_tdt
from haas_ja_local.features import log_mel
from haas_ja_local.onnx_model import HaasONNX
from haas_ja_local.tokenizer import Tokenizer

from mimivox.asr import _trim_trailing_silence
from mimivox.eval.fleurs import load_clips
from mimivox.eval.meetings import normalize_rms, read_wav

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "web" / ".models"
WEB = MODELS / "mimivox/Haas-ja-v1.0-onnx-web/resolve/fp16-v1"
SRC = MODELS / "basyauma-tech/Haas-ja-v1.0-onnx/resolve/73eda93e49262e7b66127db36d54767a0e4ef089"
FIXTURES = ROOT / "web" / "fixtures" / "asr"
BENCH = ROOT / "web" / ".bench"
TABLES = ("config.json", "window.f32", "fb.f32", "pieces.json")
MEL_CLIP = "1577"
DECODE_CLIPS = ("1577", "1578", "1582")


def bench_clips() -> dict[str, np.ndarray]:
    by_sid: dict[str, list] = {}
    for clip in load_clips():
        by_sid.setdefault(clip.sid, []).append(clip)
    rows, audio = [], {}
    (BENCH / "audio").mkdir(parents=True, exist_ok=True)
    for sid in sorted(by_sid, key=int)[:100]:
        clip = min(by_sid[sid], key=lambda c: c.wav.name)
        x = normalize_rms(read_wav(clip.wav)).astype(np.float32) / 32768.0
        x = _trim_trailing_silence(x).astype(np.float32)
        x.tofile(BENCH / "audio" / f"{sid}.f32")
        audio[sid] = x
        rows.append({"sid": sid, "wav": clip.wav.name, "ref": clip.ja_raw, "dur_s": x.size / 16000})
    (BENCH / "clips.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    return audio


def main() -> None:
    audio = bench_clips()
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for name in TABLES:
        shutil.copyfile(WEB / name, FIXTURES / name)
    cfg = HaasConfig.from_json(WEB / "config.json")
    window = np.fromfile(WEB / "window.f32", dtype=np.float32)
    fb = np.fromfile(WEB / "fb.f32", dtype=np.float32).reshape(cfg.n_mels, cfg.n_fft // 2 + 1)
    tokenizer = Tokenizer(SRC / "tokenizer.model")

    # Stored as int16 so the fixture stays small; both sides read q / 32768.
    q = np.clip(np.round(audio[MEL_CLIP] * 32768), -32768, 32767).astype("<i2")
    q.tofile(FIXTURES / f"audio_{MEL_CLIP}.i16")
    mel, n_frames = log_mel(q.astype(np.float32) / np.float32(32768), window, fb, cfg)
    mel.astype("<f4").tofile(FIXTURES / f"mel_{MEL_CLIP}.f32")

    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    cpu = ["CPUExecutionProvider"]
    backend = HaasONNX(
        cfg,
        ort.InferenceSession(str(WEB / "encoder.onnx"), so, providers=cpu),
        ort.InferenceSession(str(SRC / "fp32/decoder_joint.onnx"), so, providers=cpu),
        window,
        fb,
        "fp16",
    )
    decode = []
    for sid in DECODE_CLIPS:
        m, n = log_mel(audio[sid], window, fb, cfg)
        frames = backend.encode(m, n).astype("<f2")  # [T', d_model]
        frames.tofile(FIXTURES / f"frames_{sid}.f16")
        ids = [t.id for t in greedy_tdt(backend, frames.astype(np.float32))]
        text = tokenizer.decode(ids).strip()
        decode.append({"sid": sid, "frames": int(frames.shape[0]), "ids": ids, "text": text})

    meta = {
        "mel": {
            "sid": MEL_CLIP,
            "samples": int(q.size),
            "frames": int(n_frames),
            "padded": int(mel.shape[1]),
        },
        "decode": decode,
    }
    (FIXTURES / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n")
    print(
        json.dumps(
            {"mel": meta["mel"], "decode": [(d["sid"], d["frames"], len(d["ids"])) for d in decode]}
        )
    )


if __name__ == "__main__":
    main()

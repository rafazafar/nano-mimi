"""Export the browser ASR's front-end tables from the public Haas-ja ONNX repo.

The browser downloads every model file straight from public Hugging Face repos pinned in
``web/src/asr/models.ts`` (Sanami/haas-ja-onnx for the fp16 encoder, basyauma-tech/Haas-ja-v1.0-onnx
for the fp32 decoder and the int8 encoder). Only these four small tables have no usable public
form, so they ship same-origin from ``web/public/asr/``:

- ``window.f32`` and ``fb.f32``: the mel window and filterbank from ``preprocessor.npz``.
- ``pieces.json``: the SentencePiece pieces from ``tokenizer.model``.
- ``config.json``: copied unchanged.

Source is a local copy of ``basyauma-tech/Haas-ja-v1.0-onnx`` at ``SRC_REVISION``
(``hf download basyauma-tech/Haas-ja-v1.0-onnx --revision <sha> config.json preprocessor.npz tokenizer.model``).
It prints each file's size and sha256 for the manifest. Nothing is uploaded.

    uv run python scripts/build_web_asr_models.py --src <Haas-ja-v1.0-onnx dir>

``--en`` builds the same four tables for English Parakeet TDT 0.6B v2 into ``web/public/asr-en/``,
from a local copy of ``ysdede/parakeet-tdt-0.6b-v2-onnx`` at ``EN_REVISION`` (``nemo128.onnx`` and
``vocab.txt``). The filterbank comes from the NeMo preprocessor graph, the window is the same
Hann(400) both checkpoints use, and the config is the Haas-shaped subset the browser reads, with the
LSTM prediction network's state width in place of Haas's KDA fields.

    uv run --with onnx python scripts/build_web_asr_models.py --en <parakeet-tdt-0.6b-v2-onnx dir>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "public" / "asr"
SRC_REVISION = "73eda93e49262e7b66127db36d54767a0e4ef089"
OUT_EN = ROOT / "web" / "public" / "asr-en"
EN_REVISION = "db4a768f5795e0f508187a34241fbeeef6ebb0d3"
EN_CONFIG = {
    "sample_rate": 16000,
    "n_fft": 512,
    "win_length": 400,
    "hop_length": 160,
    "n_mels": 128,
    # NeMo's is 0. The browser pads to a multiple of 16; the encoder masks frames past `length`.
    "pad_to": 16,
    "d_model": 1024,
    "pred_layers": 2,
    "state_width": 640,
    "vocab_size": 1024,
    "durations": [0, 1, 2, 3, 4],
    "max_symbols": 10,
    "source_repo": "nvidia/parakeet-tdt-0.6b-v2",
}


def export_front_end(src: Path, out: Path) -> None:
    import sentencepiece as spm

    with np.load(src / "preprocessor.npz") as z:
        z["window"].astype(np.float32).tofile(out / "window.f32")
        z["fb"].astype(np.float32).tofile(out / "fb.f32")
    sp = spm.SentencePieceProcessor(model_file=str(src / "tokenizer.model"))
    pieces = [sp.id_to_piece(i) for i in range(sp.get_piece_size())]
    (out / "pieces.json").write_text(json.dumps(pieces, ensure_ascii=False))
    shutil.copyfile(src / "config.json", out / "config.json")


def export_parakeet_en(src: Path, out: Path) -> None:
    import onnx
    from onnx import numpy_helper

    model = onnx.load(src / "nemo128.onnx")
    nodes = [*model.graph.node, *(n for f in model.functions for n in f.node)]
    fbs = [
        numpy_helper.to_array(a.t)
        for n in nodes
        for a in n.attribute
        if a.type == onnx.AttributeProto.TENSOR and tuple(a.t.dims) == (257, 128)
    ]
    if len(fbs) != 1:
        raise SystemExit(f"expected one (257, 128) filterbank in nemo128.onnx, found {len(fbs)}")
    np.ascontiguousarray(fbs[0].T, dtype=np.float32).tofile(out / "fb.f32")
    shutil.copyfile(OUT / "window.f32", out / "window.f32")
    pieces: list[str] = []
    for line in (src / "vocab.txt").read_text(encoding="utf-8").splitlines():
        piece, index = line.rsplit(" ", 1)
        if piece != "<blk>":
            pieces.append(piece)
            assert int(index) == len(pieces) - 1, f"vocab.txt is not in id order at {line!r}"
    if len(pieces) != EN_CONFIG["vocab_size"]:
        raise SystemExit(f"vocab.txt has {len(pieces)} pieces, expected {EN_CONFIG['vocab_size']}")
    (out / "pieces.json").write_text(json.dumps(pieces, ensure_ascii=False))
    (out / "config.json").write_text(json.dumps(EN_CONFIG, indent=2) + "\n")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 24):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--src", type=Path, help="local Haas-ja-v1.0-onnx folder")
    group.add_argument("--en", type=Path, help="local parakeet-tdt-0.6b-v2-onnx folder")
    args = ap.parse_args()

    out = OUT_EN if args.en is not None else OUT
    out.mkdir(parents=True, exist_ok=True)
    if args.en is not None:
        export_parakeet_en(args.en, out)
    else:
        export_front_end(args.src, out)
    for path in sorted(p for p in out.iterdir() if p.is_file()):
        print(json.dumps({"path": path.name, "size": path.stat().st_size, "sha256": sha256(path)}))


if __name__ == "__main__":
    main()

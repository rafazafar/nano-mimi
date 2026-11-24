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


def export_front_end(src: Path, out: Path) -> None:
    import sentencepiece as spm

    with np.load(src / "preprocessor.npz") as z:
        z["window"].astype(np.float32).tofile(out / "window.f32")
        z["fb"].astype(np.float32).tofile(out / "fb.f32")
    sp = spm.SentencePieceProcessor(model_file=str(src / "tokenizer.model"))
    pieces = [sp.id_to_piece(i) for i in range(sp.get_piece_size())]
    (out / "pieces.json").write_text(json.dumps(pieces, ensure_ascii=False))
    shutil.copyfile(src / "config.json", out / "config.json")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 24):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, required=True, help="local Haas-ja-v1.0-onnx folder")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    export_front_end(args.src, OUT)
    for path in sorted(p for p in OUT.iterdir() if p.is_file()):
        print(json.dumps({"path": path.name, "size": path.stat().st_size, "sha256": sha256(path)}))


if __name__ == "__main__":
    main()

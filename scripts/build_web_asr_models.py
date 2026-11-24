"""Build the browser ASR model files and stage them in the model-store endpoint layout.

Source is a local copy of ``basyauma-tech/Haas-ja-v1.0-onnx`` (``hf download`` it). The
script writes under ``web/.models/`` exactly what ``web/src/asr/models.ts`` lists, laid out
as ``<repo>/resolve/<revision>/<path>`` so a static server over that folder can stand in
for the download endpoint:

- ``WEB_REPO``: the fp16 encoder (converted here from the fp32 export), plus the mel
  window, mel filterbank, SentencePiece pieces and config the JS front end reads.
- ``SRC_REPO``: the fp32 ``decoder_joint`` and the int8 encoder/decoder for the wasm
  fallback, hard-linked (or copied) from the source folder unchanged.

It prints each file's size and sha256 for the manifest. Nothing is uploaded.

    uv run --with onnx==1.23.2 --with onnxconverter-common==1.16.0 \\
        python scripts/build_web_asr_models.py --src <Haas-ja-v1.0-onnx dir>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
STAGE = ROOT / "web" / ".models"
SRC_REPO = "basyauma-tech/Haas-ja-v1.0-onnx"
SRC_REVISION = "73eda93e49262e7b66127db36d54767a0e4ef089"
WEB_REPO = "mimivox/Haas-ja-v1.0-onnx-web"
WEB_REVISION = "fp16-v1"
SRC_FILES = (
    "tokenizer.model",
    "fp32/decoder_joint.onnx",
    "int8/encoder.onnx",
    "int8/encoder.onnx.data",
    "int8/decoder_joint.onnx",
)


def convert_encoder_fp16(src: Path, out: Path) -> None:
    """fp16 weights and compute, fp32 I/O, loadable by the onnxruntime-web WebGPU EP."""
    import onnx
    from onnx import shape_inference
    from onnxconverter_common import float16

    # The in-memory shape inference refuses models over 2 GB, so infer on the file. The
    # result must sit beside the source, where its external-data path resolves.
    inferred = src.with_name("encoder.inferred.onnx")
    shape_inference.infer_shapes_path(str(src), str(inferred))
    model = onnx.load(str(inferred))
    m16 = float16.convert_float_to_float16(model, keep_io_types=True, disable_shape_infer=True)
    # The converter leaves the model's own Cast(to=FLOAT) nodes (attention masks, the
    # upcast around Softmax, the positional-embedding cast), so their fp32 outputs meet
    # fp16 tensors and ORT rejects the graph. Retarget them to FLOAT16, except the Range
    # inputs the converter keeps fp32 and the graph-output cast.
    consumers: dict[str, list[str]] = defaultdict(list)
    for node in m16.graph.node:
        for name in node.input:
            consumers[name].append(node.op_type)
    outputs = {o.name for o in m16.graph.output}
    for node in m16.graph.node:
        if node.op_type != "Cast":
            continue
        to = next(a for a in node.attribute if a.name == "to")
        if (
            to.i == onnx.TensorProto.FLOAT
            and "Range" not in consumers[node.output[0]]
            and node.output[0] not in outputs
        ):
            to.i = onnx.TensorProto.FLOAT16
    del m16.graph.value_info[:]  # stale fp32 entries; ORT re-infers
    onnx.save(
        m16,
        str(out / "encoder.onnx"),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location="encoder.onnx.data",
        size_threshold=1024,
    )
    inferred.unlink()


def split_decoder(src: Path, out: Path) -> None:
    """Cut the fused fp32 ``decoder_joint`` into ``predictor`` and ``joint`` at the joint's pred projection.

    Greedy TDT evaluates the joint on every frame but the prediction network only after
    each emitted token, so the browser runs the predictor ~4x less often. The ops and
    weights are the originals, so the logits are unchanged.
    """
    import onnx
    import onnx.utils

    cut, name = "/joint/pred/Gemm_output_0", "pred"
    parts = {
        "predictor.onnx": (
            ["targets", "target_length", "input_states_1", "input_states_2"],
            [cut, "output_states_1", "output_states_2"],
        ),
        "joint.onnx": (["encoder_outputs", cut], ["outputs"]),
    }
    for file, (inputs, outputs) in parts.items():
        onnx.utils.extract_model(str(src), str(out / file), inputs, outputs)
        model = onnx.load(str(out / file))
        for node in model.graph.node:
            node.input[:] = [name if i == cut else i for i in node.input]
            node.output[:] = [name if o == cut else o for o in node.output]
        for value in (*model.graph.input, *model.graph.output):
            if value.name == cut:
                value.name = name
        onnx.save(model, str(out / file))


def export_front_end(src: Path, out: Path) -> None:
    import sentencepiece as spm

    with np.load(src / "preprocessor.npz") as z:
        z["window"].astype(np.float32).tofile(out / "window.f32")
        z["fb"].astype(np.float32).tofile(out / "fb.f32")
    sp = spm.SentencePieceProcessor(model_file=str(src / "tokenizer.model"))
    pieces = [sp.id_to_piece(i) for i in range(sp.get_piece_size())]
    (out / "pieces.json").write_text(json.dumps(pieces, ensure_ascii=False))
    shutil.copyfile(src / "config.json", out / "config.json")


def link(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copyfile(src, dst)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 24):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, required=True, help="local Haas-ja-v1.0-onnx folder")
    ap.add_argument(
        "--skip-encoder", action="store_true", help="keep an already-built fp16 encoder"
    )
    args = ap.parse_args()

    web = STAGE / WEB_REPO / "resolve" / WEB_REVISION
    web.mkdir(parents=True, exist_ok=True)
    if not args.skip_encoder:
        convert_encoder_fp16(args.src / "fp32" / "encoder.onnx", web)
    export_front_end(args.src, web)
    split_decoder(args.src / "fp32" / "decoder_joint.onnx", web)
    base = STAGE / SRC_REPO / "resolve" / SRC_REVISION
    for rel in SRC_FILES:
        link(args.src / rel, base / rel)

    for root in (web, base):
        for path in sorted(p for p in root.rglob("*") if p.is_file()):
            rel = path.relative_to(root).as_posix()
            print(json.dumps({"path": rel, "size": path.stat().st_size, "sha256": sha256(path)}))


if __name__ == "__main__":
    main()

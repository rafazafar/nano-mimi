import type { CapabilityIssue, FileSpec, ModelSpec } from "../models";

/**
 * Haas-ja (Parakeet TDT) for Japanese ASR, the runtime S0b picked (docs/plans/s0/s0b-asr.md).
 * Every file is a public Hugging Face file pinned to a commit, except the four small front-end
 * tables, which ship same-origin from `public/asr/`. All of it derives from
 * third-intelligence/Haas-ja-v1.0 (Apache-2.0); each repo below carries the Apache-2.0 LICENSE.
 */

/** Unofficial ONNX conversion by basyauma-tech: the fp32 fused decoder and the int8 CPU encoder. */
const SRC_REPO = "basyauma-tech/Haas-ja-v1.0-onnx";
const SRC_REVISION = "73eda93e49262e7b66127db36d54767a0e4ef089";
/** Unofficial ONNX conversion by Sanami: the fp16 encoder the WebGPU EP runs. */
const FP16_REPO = "Sanami/haas-ja-onnx";
const FP16_REVISION = "354baedfd9612b00e74cc1ae87dff7f2c558db6f";

const table = (path: string, size: number, sha256: string): FileSpec => ({ path, url: `/asr/${path}`, size, sha256 });

/**
 * Config, mel window and filterbank, and SentencePiece pieces, exported from SRC_REPO's
 * config.json, preprocessor.npz and tokenizer.model by `scripts/build_web_asr_models.py`
 * (copies are in `web/fixtures/asr/`). Served same-origin from `public/asr/`.
 */
export const HAAS_TABLES: ModelSpec = {
  id: "haas-ja-tables",
  label: "Haas-ja tokenizer and features",
  repo: SRC_REPO,
  revision: SRC_REVISION,
  files: [
    table("config.json", 640, "907721ac7efa8454a35ae492314e6de5fa8e9722d42b783963ae293d8f41f11b"),
    table("window.f32", 1600, "6a66c2c694505b41b8987c4885a618e1a32612b43a4935a208a3c9c956b22d02"),
    table("fb.f32", 131584, "eb5cf9eb93b8038062ebc849b14ec85098abe1c915bc22262be8ad336bcf563a"),
    table("pieces.json", 23660, "8404c5fdfc5c80ad3ebcf030eae2e5456da6cb1c266131acb561019988f52b67"),
  ],
};

/** The fp16 encoder (fp32 I/O) for the WebGPU EP. */
export const HAAS_FP16: ModelSpec = {
  id: "haas-ja-encoder-fp16",
  label: "Haas-ja speech recognition (WebGPU, fp16)",
  repo: FP16_REPO,
  revision: FP16_REVISION,
  files: [
    { path: "fp16/encoder.onnx", size: 42205249, sha256: "7a97385c7d83541d43ed2b40549307af8e4618da79c3b2b9c622e47b98e7c0ab" },
    { path: "fp16/encoder.onnx.data", size: 1217707520, sha256: "7a96f9f6ad721dee4afdc5741ba3c68f10aadb4333c77b1c6b231253b781d25d" },
  ],
  gpu: { shaderF16: true, minMaxBufferSize: 134_217_728, minMaxStorageBufferBindingSize: 134_217_728 },
};

/** The fp32 fused prediction network + joint; run on the wasm EP by both backends. */
export const HAAS_DECODER: ModelSpec = {
  id: "haas-ja-decoder-fp32",
  label: "Haas-ja decoder",
  repo: SRC_REPO,
  revision: SRC_REVISION,
  files: [{ path: "fp32/decoder_joint.onnx", size: 27712720, sha256: "9e1e99ec8d4a0ea43b19f8572b3fd02beae2dfb7f671e2ff975dd0d7428d626a" }],
};

/** The int8 encoder for machines without a usable WebGPU adapter (B′ in S0b). */
export const HAAS_INT8: ModelSpec = {
  id: "haas-ja-encoder-int8",
  label: "Haas-ja speech recognition (CPU, int8)",
  repo: SRC_REPO,
  revision: SRC_REVISION,
  files: [
    { path: "int8/encoder.onnx", size: 3198708, sha256: "f36c5a24e5a43c58321244b9b396f15f00277a48e93574a2bb79308c17cd3234" },
    { path: "int8/encoder.onnx.data", size: 609822464, sha256: "03db20b51fd813f6b694309520621f66ea331dc7769f7679d936237a0abdb27a" },
  ],
};

export type AsrBackend = "webgpu" | "wasm";

/** Each backend's encoder graph and its external-data sidecar; the decoder is HAAS_DECODER for both. */
export const ASR_ENCODER: Readonly<Record<AsrBackend, { readonly model: ModelSpec; readonly path: string; readonly data: string }>> = {
  webgpu: { model: HAAS_FP16, path: "fp16/encoder.onnx", data: "fp16/encoder.onnx.data" },
  wasm: { model: HAAS_INT8, path: "int8/encoder.onnx", data: "int8/encoder.onnx.data" },
};

/** What each backend downloads. */
export const ASR_MODELS: Readonly<Record<AsrBackend, readonly ModelSpec[]>> = {
  webgpu: [HAAS_TABLES, HAAS_FP16, HAAS_DECODER],
  wasm: [HAAS_TABLES, HAAS_INT8, HAAS_DECODER],
};

/** WebGPU when W3's capability check found nothing wrong for the fp16 model, otherwise the int8 CPU path. */
export function asrBackend(issues: readonly CapabilityIssue[]): AsrBackend {
  return issues.length === 0 ? "webgpu" : "wasm";
}

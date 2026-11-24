import type { CapabilityIssue, ModelSpec } from "../models";

/**
 * Haas-ja (Parakeet TDT) for Japanese ASR, the runtime S0b picked
 * (docs/plans/s0/s0b-asr.md). `scripts/build_web_asr_models.py` builds and stages
 * every file below and prints these sizes and hashes.
 */

/** Our own files: not hosted anywhere yet (open product call 2, model hosting). */
const WEB_REPO = "mimivox/Haas-ja-v1.0-onnx-web";
const WEB_REVISION = "fp16-v1";
const SRC_REPO = "basyauma-tech/Haas-ja-v1.0-onnx";
const SRC_REVISION = "73eda93e49262e7b66127db36d54767a0e4ef089";

/** Config, mel window and filterbank, and SentencePiece pieces, exported from the checkpoint for the JS front end. */
export const HAAS_TABLES: ModelSpec = {
  id: "haas-ja-tables",
  label: "Haas-ja tokenizer and features",
  repo: WEB_REPO,
  revision: WEB_REVISION,
  files: [
    { path: "config.json", size: 640, sha256: "907721ac7efa8454a35ae492314e6de5fa8e9722d42b783963ae293d8f41f11b" },
    { path: "window.f32", size: 1600, sha256: "6a66c2c694505b41b8987c4885a618e1a32612b43a4935a208a3c9c956b22d02" },
    { path: "fb.f32", size: 131584, sha256: "eb5cf9eb93b8038062ebc849b14ec85098abe1c915bc22262be8ad336bcf563a" },
    { path: "pieces.json", size: 23660, sha256: "8404c5fdfc5c80ad3ebcf030eae2e5456da6cb1c266131acb561019988f52b67" },
  ],
};

/** Our fp16 conversion of the fp32 encoder, for the WebGPU EP. */
export const HAAS_FP16: ModelSpec = {
  id: "haas-ja-encoder-fp16",
  label: "Haas-ja speech recognition (WebGPU, fp16)",
  repo: WEB_REPO,
  revision: WEB_REVISION,
  files: [
    { path: "encoder.onnx", size: 742282, sha256: "0fc2caf0ae75337cb09f7be8502c16121a94ee76f2e86041ba4697c76a1ad8c7" },
    { path: "encoder.onnx.data", size: 1217707520, sha256: "a7bfecd4fcbee03b674efcb2e3ce087c35042b8e70608caafc2d5918d894624d" },
  ],
  gpu: { shaderF16: true, minMaxBufferSize: 134_217_728, minMaxStorageBufferBindingSize: 134_217_728 },
};

/** The fp32 transducer decoder, cut into its prediction network and joint; run on the wasm EP by both backends. */
export const HAAS_DECODER: ModelSpec = {
  id: "haas-ja-decoder-fp32",
  label: "Haas-ja decoder",
  repo: WEB_REPO,
  revision: WEB_REVISION,
  files: [
    { path: "predictor.onnx", size: 17226544, sha256: "cefc367652c2e5d788e31da05dc460feacc94b82648ce6602a158bc46c29a377" },
    { path: "joint.onnx", size: 10517962, sha256: "4465c394aa447b1cdea244e8edf72f1913467ccdf770abafc485d600d309f5cf" },
  ],
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
  webgpu: { model: HAAS_FP16, path: "encoder.onnx", data: "encoder.onnx.data" },
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

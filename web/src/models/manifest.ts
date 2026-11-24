import { asrModels } from "../asr/models";
import type { Manifest, ModelSpec } from "./types";

/**
 * CAT-Translate 0.8B as an onnxruntime-genai builder export (int4 RTN block 32, fp16
 * activations and KV) in transformers.js layout, with `kv_cache_dim` pinned to 80.
 * Recipe: docs/plans/s0/s0a-mt.md. Published at huggingface.co/rafazafar/CAT-Translate-0.8b-onnx-q4f16.
 * Chosen over 1.4B for memory: on FLEURS ja→en chrF is 51.83 vs 52.21, at 0.6 GB less GPU memory.
 */
export const CAT_MODEL: ModelSpec = {
  id: "cat-translate-0.8b-q4f16",
  label: "CAT-Translate 0.8B (q4f16)",
  repo: "rafazafar/CAT-Translate-0.8b-onnx-q4f16",
  revision: "f81acb8e9359de60f6d789c3e2a059e588c5be49",
  files: [
    { path: "config.json", size: 797, sha256: "c1eab16e313fe5f56328b17f4ef512d1c3cc2ece51eb633135527890ef21d046" },
    { path: "generation_config.json", size: 57, sha256: "1fe0904792688508097442fed4b9beed2a9770c480cb1db8efdd0807b8b3c51f" },
    { path: "tokenizer.json", size: 6724259, sha256: "26df73eb8312c8bc571cb27123198be013ff591c5d9b683e16ccb450ac3426de" },
    { path: "tokenizer_config.json", size: 6449, sha256: "76b4610d6667bb74335ad383d79362cb43a27ac7aa51ae84942cd63b0cb60b97" },
    { path: "onnx/model_q4f16.onnx", size: 173065, sha256: "210225eacd99229e488a461c5dd139e8d3bcefa63c1135a1cf3163f5b7fea640" },
    { path: "onnx/model_q4f16.onnx_data", size: 635906560, sha256: "ded1bbc77b25847244aff1f97b3590dc94a6dfbdfb3a92d1e5c0795264344cb1" },
  ],
  // The fp16 embedding table (102400 x 1280) is one 262 MB buffer.
  gpu: { shaderF16: true, minMaxBufferSize: 262_144_000, minMaxStorageBufferBindingSize: 262_144_000 },
};

/**
 * The shipped model list. Add entries here (see `ModelSpec`) rather than changing the store.
 * The ASR entries are the WebGPU set; picking the int8 set on machines that fail the
 * capability check (`asrBackend`) is the app's job. The setup page can also load a manifest
 * from `?manifest=<url>` and an endpoint from `?endpoint=<url>` for testing.
 */
export const DEFAULT_MANIFEST: Manifest = { models: [...asrModels("ja-en", "webgpu"), CAT_MODEL] };

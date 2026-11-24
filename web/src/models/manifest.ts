import { ASR_MODELS } from "../asr/models";
import type { Manifest, ModelSpec } from "./types";

/**
 * CAT-Translate 1.4B as an onnxruntime-genai builder export (int4 RTN block 32, fp16
 * activations and KV) in transformers.js layout, with `kv_cache_dim` pinned to 112.
 * Recipe: docs/plans/s0/s0a-mt.md. Published at huggingface.co/rafazafar/CAT-Translate-1.4b-onnx-q4f16.
 */
export const CAT_MODEL: ModelSpec = {
  id: "cat-translate-1.4b-q4f16",
  label: "CAT-Translate 1.4B (q4f16)",
  repo: "rafazafar/CAT-Translate-1.4b-onnx-q4f16",
  revision: "261cb0fa98839410ce7941040e6eb09303555aa3",
  files: [
    { path: "config.json", size: 826, sha256: "6d698e10e34e5b8f678b2b4f0b6b1229e9588c36cbcdabc402dcc6d9c82da88b" },
    { path: "generation_config.json", size: 57, sha256: "1fe0904792688508097442fed4b9beed2a9770c480cb1db8efdd0807b8b3c51f" },
    { path: "tokenizer.json", size: 6724259, sha256: "26df73eb8312c8bc571cb27123198be013ff591c5d9b683e16ccb450ac3426de" },
    { path: "tokenizer_config.json", size: 6449, sha256: "76b4610d6667bb74335ad383d79362cb43a27ac7aa51ae84942cd63b0cb60b97" },
    { path: "onnx/model_q4f16.onnx", size: 173139, sha256: "542fc0041cb86b3458dee1e5f3976ae00040b87bf02f29c760586daf3a3d06f9" },
    {
      path: "onnx/model_q4f16.onnx_data",
      size: 1057484288,
      sha256: "f924eae83fa0aba73938c74c306ba9cd50087f616e786c438ae61de9fedc8ed2",
    },
  ],
  // The fp16 embedding table (102400 x 1792) is one 367 MB buffer.
  gpu: { shaderF16: true, minMaxBufferSize: 367_001_600, minMaxStorageBufferBindingSize: 367_001_600 },
};

/**
 * The shipped model list. Add entries here (see `ModelSpec`) rather than changing the store.
 * The ASR entries are the WebGPU set; picking the int8 set on machines that fail the
 * capability check (`asrBackend`) is the app's job. The setup page can also load a manifest
 * from `?manifest=<url>` and an endpoint from `?endpoint=<url>` for testing.
 */
export const DEFAULT_MANIFEST: Manifest = { models: [...ASR_MODELS.webgpu, CAT_MODEL] };

import * as ort from "onnxruntime-web/wasm";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { SileroOnnx } from "./silero";

/**
 * Silero on the wasm execution provider with one thread: threads need
 * cross-origin isolation, and a 2 MB recurrent model gains nothing from them.
 */
export function loadSilero(): Promise<SileroOnnx> {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
  return SileroOnnx.create(ort, `${import.meta.env.BASE_URL}silero_vad.onnx`);
}

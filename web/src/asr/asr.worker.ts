/// <reference lib="webworker" />
import type * as Ort from "onnxruntime-web";
import asyncifyWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import plainWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import * as ortCpu from "onnxruntime-web/wasm";
import * as ortGpu from "onnxruntime-web/webgpu";
import { ModelStore, OpfsBlobStore } from "../models";
import { asyncifyWasmUrl } from "../runtimeWasm";
import { parseHaasConfig } from "./config";
import { HaasRecognizer, type HaasTables } from "./haas";
import { ASR_ENCODER, HAAS_DECODER, HAAS_TABLES, type AsrBackend } from "./models";
import type { AsrDevice, AsrInit, AsrRequest, AsrResponse } from "./protocol";
import { parsePieces } from "./tokenizer";

declare const self: DedicatedWorkerGlobalScope;

function post(msg: AsrResponse): void {
  self.postMessage(msg);
}

async function loadTables(store: ModelStore): Promise<HaasTables> {
  const buf = (path: string): Promise<ArrayBuffer> => store.getArrayBuffer(HAAS_TABLES.id, path);
  const json = async (path: string): Promise<unknown> => JSON.parse(new TextDecoder().decode(await buf(path)));
  return {
    config: parseHaasConfig(await json("config.json")),
    window: new Float32Array(await buf("window.f32")),
    fb: new Float32Array(await buf("fb.f32")),
    pieces: parsePieces(await json("pieces.json")),
  };
}

async function describeDevice(backend: AsrBackend): Promise<AsrDevice> {
  const base = { backend, crossOriginIsolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency };
  if (backend !== "webgpu") return base;
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error("no WebGPU adapter");
  const { vendor, architecture, isFallbackAdapter } = adapter.info;
  return { ...base, adapter: { vendor, architecture, isFallbackAdapter, shaderF16: adapter.features.has("shader-f16"), features: [...adapter.features].sort() } };
}

async function init(req: AsrInit): Promise<HaasRecognizer> {
  const t0 = performance.now();
  const store = new ModelStore({ manifest: req.manifest, store: new OpfsBlobStore() });
  await store.refresh();
  if (!store.allReady()) throw new Error("ASR models are not downloaded; run the model setup first");
  // Only the WebGPU EP needs the asyncify build. Everything on the wasm EP, the decoder's ~250 small
  // runs per clip above all, uses the plain build, which skips asyncify's instrumentation.
  ortGpu.env.wasm.numThreads = req.threads;
  ortGpu.env.wasm.wasmPaths = { wasm: asyncifyWasmUrl(__ORT_VERSION__, asyncifyWasm) };
  ortCpu.env.wasm.numThreads = req.threads;
  ortCpu.env.wasm.wasmPaths = { wasm: plainWasm };
  const encOrt = req.backend === "webgpu" ? ortGpu : ortCpu;
  const enc = ASR_ENCODER[req.backend];
  const encUrl = await store.getObjectUrl(enc.model.id, enc.path);
  const dataUrl = await store.getObjectUrl(enc.model.id, enc.data);
  const decoderSession = async (): Promise<Ort.InferenceSession> =>
    ortCpu.InferenceSession.create(new Uint8Array(await store.getArrayBuffer(HAAS_DECODER.id, HAAS_DECODER.files[0]!.path)), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  try {
    const [tables, encoder, decoder] = await Promise.all([
      loadTables(store),
      encOrt.InferenceSession.create(encUrl, {
        executionProviders: [req.backend === "webgpu" ? { name: "webgpu" } : "wasm"],
        graphOptimizationLevel: "all",
        externalData: [{ path: enc.data.split("/").pop()!, data: dataUrl }],
      }),
      decoderSession(),
    ]);
    const device = await describeDevice(req.backend);
    post({ type: "ready", device, loadMs: performance.now() - t0 });
    return new HaasRecognizer(tables, { ort: encOrt, session: encoder }, { ort: ortCpu, decoder });
  } finally {
    URL.revokeObjectURL(encUrl);
    URL.revokeObjectURL(dataUrl);
  }
}

let recognizer: Promise<HaasRecognizer> | undefined;
/** Requests run one at a time, in arrival order. */
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (e: MessageEvent<AsrRequest>) => {
  const req = e.data;
  switch (req.type) {
    case "init":
      recognizer = init(req);
      recognizer.catch((err: unknown) => post({ type: "error", id: null, message: String(err) }));
      return;
    case "transcribe": {
      const r = recognizer;
      if (r === undefined) {
        post({ type: "error", id: req.id, message: "transcribe before init" });
        return;
      }
      queue = queue.then(async () => {
        try {
          post({ type: "transcript", id: req.id, transcript: await (await r).transcribe(req.samples) });
        } catch (err) {
          post({ type: "error", id: req.id, message: String(err) });
        }
      });
      return;
    }
  }
};

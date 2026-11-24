// Spike: English Parakeet TDT 0.6B v2 through the existing Haas TDT front end and decoder.
//
//   PK=<dir with istupakov/parakeet-tdt-0.6b-v2-onnx files> CLIPS=<dir with clips.json + <sid>.f32> \
//     npx vitest run -c bench/spike.vitest.config.ts bench/en-asr.spike.test.ts
//
// Runs the int8 encoder on the wasm EP in Node (CPU numbers only) and writes $CLIPS/asr_en.json.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web/wasm";
import { it } from "vitest";
import type { HaasConfig } from "../src/asr/config";
import { HaasRecognizer } from "../src/asr/haas";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PK = process.env["PK"]!;
const CLIPS = process.env["CLIPS"]!;

/** Parakeet-EN differs from Haas-ja in vocab (1024) and its LSTM prediction net (2 x 640 state). */
const config: HaasConfig = {
  sampleRate: 16000,
  nFft: 512,
  winLength: 400,
  hopLength: 160,
  nMels: 128,
  padTo: 16, // NeMo's is 0; extra zero frames sit past `length`, which the encoder masks.
  dModel: 1024,
  predLayers: 2,
  vocabSize: 1024,
  durations: [0, 1, 2, 3, 4],
  maxSymbols: 10,
  stateWidth: 640,
};

function f32(path: string): Float32Array {
  const b = readFileSync(path);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

it("transcribes the FLEURS en_us clips", { timeout: 1_800_000 }, async () => {
  const vocab = readFileSync(`${PK}/vocab.txt`, "utf8").trim().split("\n");
  const pieces: string[] = [];
  for (const line of vocab) {
    const at = line.lastIndexOf(" ");
    pieces[Number(line.slice(at + 1))] = line.slice(0, at);
  }
  pieces.length = config.vocabSize;

  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmBinary = readFileSync(`${ROOT}node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm`) as unknown as ArrayBuffer;
  const t0 = performance.now();
  const encoder = await ort.InferenceSession.create(readFileSync(`${PK}/encoder-model.int8.onnx`), { executionProviders: ["wasm"] });
  const decoder = await ort.InferenceSession.create(readFileSync(`${PK}/decoder_joint-model.onnx`), { executionProviders: ["wasm"] });
  console.log(`load ${(performance.now() - t0).toFixed(0)} ms; enc in ${encoder.inputNames} out ${encoder.outputNames}; dec in ${decoder.inputNames} out ${decoder.outputNames}`);

  // Haas-ja's window and filterbank: NeMo's defaults (hann 400, slaney 128-mel at 16 kHz), shared by both checkpoints.
  const rec = new HaasRecognizer(
    { config, window: f32(`${ROOT}fixtures/asr/window.f32`), fb: f32(`${ROOT}fixtures/asr/fb.f32`), pieces },
    { ort, session: encoder },
    { ort, decoder },
  );
  const clips = JSON.parse(readFileSync(`${CLIPS}/clips.json`, "utf8")) as { sid: string; dur: number }[];
  const rows = [];
  for (const c of clips) {
    const t = performance.now();
    const tr = await rec.transcribe(f32(`${CLIPS}/${c.sid}.f32`));
    const ms = performance.now() - t;
    rows.push({ sid: c.sid, text: tr.raw, ms, dur: c.dur, ...tr.timing });
    console.log(`${c.sid} ${(ms / 1000).toFixed(2)}s/${c.dur.toFixed(1)}s  ${tr.raw}`);
  }
  writeFileSync(`${CLIPS}/asr_en.json`, JSON.stringify(rows, null, 1));
});

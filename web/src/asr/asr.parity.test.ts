import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web/wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { readFixture } from "../test/fixtures";
import { parseHaasConfig, type HaasConfig } from "./config";
import { HaasRecognizer, type HaasTables } from "./haas";
import { MelFrontEnd } from "./mel";
import { PieceDecoder, parsePieces } from "./tokenizer";
import { trimTrailingSilence } from "./trim";

interface Meta {
  readonly mel: { readonly sid: string; readonly samples: number; readonly frames: number; readonly padded: number };
  readonly decode: readonly { readonly sid: string; readonly frames: number; readonly ids: readonly number[]; readonly text: string }[];
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIX = `${ROOT}fixtures/asr/`;
/** Staged by scripts/build_web_asr_models.py; too big to commit. */
const DECODER = `${ROOT}.models/basyauma-tech/Haas-ja-v1.0-onnx/resolve/73eda93e49262e7b66127db36d54767a0e4ef089/fp32/decoder_joint.onnx`;

function bytes(name: string): Uint8Array {
  const b = readFileSync(FIX + name);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

function f32(name: string): Float32Array {
  return new Float32Array(bytes(name).slice().buffer);
}

function f16(name: string): Float32Array {
  const h = new Uint16Array(bytes(name).slice().buffer);
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const x = h[i]!;
    const sign = x & 0x8000 ? -1 : 1;
    const exp = (x >> 10) & 0x1f;
    const frac = x & 0x3ff;
    out[i] = exp === 0 ? sign * 2 ** -14 * (frac / 1024) : exp === 31 ? (frac ? NaN : sign * Infinity) : sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }
  return out;
}

const meta = readFixture<Meta>("asr/meta.json");
const config: HaasConfig = parseHaasConfig(readFixture<unknown>("asr/config.json"));
const tables: HaasTables = {
  config,
  window: f32("window.f32"),
  fb: f32("fb.f32"),
  pieces: parsePieces(readFixture<unknown>("asr/pieces.json")),
};

describe("log-mel", () => {
  it("matches haas_ja_local log_mel within 1e-4", () => {
    const q = new Int16Array(bytes(`audio_${meta.mel.sid}.i16`).slice().buffer);
    const samples = Float32Array.from(q, (v) => v / 32768);
    const ref = f32(`mel_${meta.mel.sid}.f32`);
    const out = new MelFrontEnd(config, tables.window, tables.fb).compute(samples);
    expect(out.frames).toBe(meta.mel.frames);
    expect(out.padded).toBe(meta.mel.padded);
    expect(out.mel.length).toBe(ref.length);
    let maxErr = 0;
    for (let i = 0; i < ref.length; i++) maxErr = Math.max(maxErr, Math.abs(ref[i]! - out.mel[i]!));
    console.log(`log-mel max |js - python| over ${ref.length} values = ${maxErr.toExponential(2)}`);
    expect(maxErr).toBeLessThan(1e-4);
  });

  it("gives no frames for a clip shorter than one hop", () => {
    expect(new MelFrontEnd(config, tables.window, tables.fb).compute(new Float32Array(100)).frames).toBe(0);
  });
});

describe("detokenizer", () => {
  it.each(meta.decode.map((d) => [d.sid, d] as const))("decodes clip %s's ids to SentencePiece's text", (_sid, d) => {
    expect(new PieceDecoder(tables.pieces).decode(d.ids)).toBe(d.text);
  });
});

describe.skipIf(!existsSync(DECODER))("TDT greedy decode (stage models with scripts/build_web_asr_models.py)", () => {
  let recognizer: HaasRecognizer;

  beforeAll(async () => {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmBinary = readFileSync(`${ROOT}node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm`) as unknown as ArrayBuffer;
    const decoder = await ort.InferenceSession.create(readFileSync(DECODER), { executionProviders: ["wasm"] });
    recognizer = new HaasRecognizer(tables, null as never, { ort, decoder });
  });

  it.each(meta.decode.map((d) => [d.sid, d] as const))("emits Python's token ids on clip %s's encoder frames", async (_sid, d) => {
    const data = f16(`frames_${d.sid}.f16`);
    expect(data.length).toBe(d.frames * config.dModel);
    const { ids } = await recognizer.decode({ data, frames: d.frames });
    expect(ids).toEqual(d.ids);
  });
});

describe("trailing-silence trim", () => {
  it("keeps 20 ms after the last sample at or above 0.01", () => {
    const x = new Float32Array(16_000);
    x[1000] = 0.01;
    x[1001] = 0.009;
    expect(trimTrailingSilence(x).length).toBe(1000 + 1 + 320);
  });

  it("keeps only what remains when the loud sample is near the end", () => {
    const x = new Float32Array(1000);
    x[990] = -0.5;
    expect(trimTrailingSilence(x).length).toBe(1000);
  });

  it("returns an all-quiet clip whole, like asr.py", () => {
    const x = new Float32Array(500).fill(0.001);
    expect(trimTrailingSilence(x).length).toBe(500);
  });
});

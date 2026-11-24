import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web/wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { readFixture } from "../test/fixtures";
import { SileroOnnx } from "./silero";
import { StreamingVad, emitted, type WindowScorer } from "./streamingVad";
import { LIVE_TUNING, WINDOW, type Candidate } from "./vadStateMachine";
import { decodeWav } from "./wav";

interface WavFixture {
  readonly wav: { readonly name: string; readonly samples: number; readonly sha256: string };
  readonly utterances: readonly {
    readonly start: number;
    readonly end: number;
    readonly emitted: boolean;
    readonly emitted_samples: number;
  }[];
  readonly vad_wait_s: readonly number[];
  readonly window_probs: readonly number[];
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WAV_DIR = fileURLToPath(new URL("../../../data/fixtures/", import.meta.url));
/** The fixture stores probabilities rounded to 6 decimals, so 5e-7 is the floor. */
const PROB_TOLERANCE = 1e-5;

class Recording implements WindowScorer {
  readonly probs: number[] = [];
  constructor(private readonly inner: SileroOnnx) {}
  async score(win: Float32Array): Promise<number> {
    const p = await this.inner.score(win);
    this.probs.push(p);
    return p;
  }
  reset(): void {
    this.inner.reset();
  }
}

let model: Uint8Array;

beforeAll(() => {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmBinary = readFileSync(
    ROOT + "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
  ) as unknown as ArrayBuffer;
  model = readFileSync(ROOT + "public/silero_vad.onnx");
});

for (const name of ["meeting-recording", "meeting-recording-split"]) {
  const wavPath = `${WAV_DIR}${name}.wav`;
  describe.skipIf(!existsSync(wavPath))(`Silero parity on ${name}.wav (run make fixture)`, () => {
    const fixture = readFixture<WavFixture>(`vad/${name}.json`);

    it("is the recording the fixture was exported from", () => {
      const bytes = readFileSync(wavPath);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixture.wav.sha256);
      expect(decodeWav(bytes).samples.length).toBe(fixture.wav.samples);
    });

    it("scores every window like the Python model and cuts the same utterances", async () => {
      const { samples } = decodeWav(readFileSync(wavPath));
      const scorer = new Recording(await SileroOnnx.create(ort, model));
      const vad = new StreamingVad(LIVE_TUNING, scorer);
      const candidates: Candidate[] = [];
      for (let i = 0; i < samples.length; i += 1600) {
        candidates.push(...(await vad.feed(samples.subarray(i, i + 1600))));
      }
      candidates.push(...(await vad.flush()));

      expect(scorer.probs.length).toBe(fixture.window_probs.length);
      let maxDiff = 0;
      fixture.window_probs.forEach((expected, i) => {
        maxDiff = Math.max(maxDiff, Math.abs((scorer.probs[i] as number) - expected));
      });
      console.log(`${name}: max |p - python p| over ${scorer.probs.length} windows = ${maxDiff}`);
      expect(maxDiff).toBeLessThan(PROB_TOLERANCE);

      expect(candidates.length).toBe(fixture.utterances.length);
      let worst = 0;
      candidates.forEach((c, i) => {
        const expected = fixture.utterances[i]!;
        worst = Math.max(worst, Math.abs(c.start - expected.start), Math.abs(c.end - expected.end));
        expect(c.samples !== null).toBe(expected.emitted);
      });
      console.log(`${name}: worst boundary offset = ${worst} samples (limit ${WINDOW})`);
      expect(worst).toBeLessThanOrEqual(WINDOW);
      expect(emitted(candidates).length).toBe(fixture.vad_wait_s.length);
    });
  });
}

import { describe, expect, it } from "vitest";
import { Resampler, resampleTo16k } from "./resampler";

function sine(rate: number, hz: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

function rms(x: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (x[i] as number) ** 2;
  return Math.sqrt(sum / (to - from));
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function streamed(input: Float32Array, rate: number, block: number): Float32Array {
  const r = new Resampler(rate);
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += block) parts.push(r.process(input.subarray(i, i + block)));
  return concat(parts);
}

describe.each([48_000, 44_100, 32_000, 22_050, 8_000])("resampling %d Hz to 16 kHz", (rate) => {
  const input = sine(rate, 440, 1);

  it("gives bit-identical output for any block size", () => {
    const reference = streamed(input, rate, input.length);
    for (const block of [1, 7, 128, 441, 5000]) {
      expect(streamed(input, rate, block)).toEqual(reference);
    }
  });

  it("puts output sample n at n / 16000 s with unit gain", () => {
    const out = resampleTo16k(input, rate);
    for (let n = 1000; n < 15000; n += 97) {
      expect(out[n]).toBeCloseTo(0.5 * Math.sin((2 * Math.PI * 440 * n) / 16_000), 3);
    }
  });
});

describe("resampling 48 kHz to 16 kHz", () => {
  it("passes speech band and rejects what would alias into it", () => {
    const pass = resampleTo16k(sine(48_000, 3000, 1), 48_000);
    const stop = resampleTo16k(sine(48_000, 12_000, 1), 48_000);
    expect(rms(pass, 1000, 15000)).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(20 * Math.log10(rms(stop, 1000, 15000) / (0.5 / Math.SQRT2))).toBeLessThan(-80);
  });

  it("returns 16 kHz input unchanged", () => {
    const input = sine(16_000, 440, 0.1);
    expect(resampleTo16k(input, 16_000)).toEqual(input);
  });

  it("emits the stream's length in samples once flushed", () => {
    expect(resampleTo16k(new Float32Array(48_000), 48_000).length).toBe(16_000);
  });

  it("refuses rates it cannot express as a small ratio", () => {
    expect(() => new Resampler(48_001)).toThrow();
  });
});

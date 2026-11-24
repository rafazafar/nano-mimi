import { SAMPLE_RATE } from "./vadStateMachine";

/** Zero crossings of the lowpass on each side, counted at the output rate. */
const ZERO_CROSSINGS = 32;
/** -6 dB point of the lowpass as a fraction of the output rate (7.6 kHz at 16 kHz). */
const CUTOFF = 0.475;
const KAISER_BETA = 9;
const MAX_PHASES = 2048;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function besselI0(x: number): number {
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 64; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

function sinc(x: number): number {
  return x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
}

/**
 * Deterministic streaming resampler from any rational rate ratio to 16 kHz.
 *
 * Each output sample is a Kaiser-windowed-sinc sum over the surrounding input
 * samples, with one precomputed filter per fractional phase. Output sample `n`
 * sits exactly at `n / 16000` seconds, with no delay. The result depends only on
 * the input samples, never on how they were split across `process` calls.
 */
export class Resampler {
  readonly #up: number;
  readonly #down: number;
  readonly #half: number;
  readonly #taps: number;
  readonly #table: Float64Array;
  #buf = new Float32Array(0);
  #bufLength = 0;
  /** Input index of `#buf[0]`. */
  #bufStart: number;
  #nextOut = 0;

  constructor(inputRate: number) {
    const g = Number.isInteger(inputRate) && inputRate > 0 ? gcd(inputRate, SAMPLE_RATE) : 0;
    this.#up = g === 0 ? Infinity : SAMPLE_RATE / g;
    this.#down = inputRate / g;
    if (this.#up > MAX_PHASES) {
      throw new Error(`Cannot resample ${inputRate} Hz to ${SAMPLE_RATE} Hz`);
    }
    this.#half = Math.ceil((ZERO_CROSSINGS * this.#down) / this.#up);
    this.#taps = 2 * this.#half;
    this.#table = this.#buildTable();
    this.#bufStart = -(this.#half - 1);
    this.#buf = new Float32Array(this.#half - 1 + 1024);
    this.#bufLength = this.#half - 1;
  }

  #buildTable(): Float64Array {
    const ratio = this.#up / this.#down;
    const cutoff = CUTOFF * Math.min(1, ratio);
    const table = new Float64Array(this.#up * this.#taps);
    const i0Beta = besselI0(KAISER_BETA);
    for (let phase = 0; phase < this.#up; phase++) {
      const row = phase * this.#taps;
      let sum = 0;
      for (let j = 0; j < this.#taps; j++) {
        const x = j - this.#half + 1 - phase / this.#up;
        const r = x / this.#half;
        const window = Math.abs(r) >= 1 ? 0 : besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / i0Beta;
        const weight = 2 * cutoff * sinc(2 * cutoff * x) * window;
        table[row + j] = weight;
        sum += weight;
      }
      for (let j = 0; j < this.#taps; j++) table[row + j] = (table[row + j] as number) / sum;
    }
    return table;
  }

  /** Resamples the next block of the stream and returns the output samples that are now complete. */
  process(input: Float32Array): Float32Array {
    if (this.#up === this.#down) return input.slice();
    this.#append(input);
    const half = this.#half;
    const taps = this.#taps;
    const lastIndex = this.#bufStart + this.#bufLength - 1;
    const out = new Float32Array(Math.ceil((input.length * this.#up) / this.#down) + 2);
    let produced = 0;
    for (;;) {
      const position = this.#nextOut * this.#down;
      const base = Math.floor(position / this.#up);
      if (base + half > lastIndex) break;
      const row = (position - base * this.#up) * taps;
      const first = base - half + 1 - this.#bufStart;
      let acc = 0;
      for (let j = 0; j < taps; j++) {
        acc += (this.#table[row + j] as number) * (this.#buf[first + j] as number);
      }
      out[produced++] = acc;
      this.#nextOut++;
    }
    this.#dropConsumed();
    return out.slice(0, produced);
  }

  /** Emits the outputs that still wait on input past the end of the stream, treating it as silence. */
  flush(): Float32Array {
    if (this.#up === this.#down) return new Float32Array(0);
    return this.process(new Float32Array(this.#half));
  }

  #append(input: Float32Array): void {
    const needed = this.#bufLength + input.length;
    if (needed > this.#buf.length) {
      const grown = new Float32Array(Math.max(needed, this.#buf.length * 2));
      grown.set(this.#buf.subarray(0, this.#bufLength));
      this.#buf = grown;
    }
    this.#buf.set(input, this.#bufLength);
    this.#bufLength = needed;
  }

  #dropConsumed(): void {
    const nextBase = Math.floor((this.#nextOut * this.#down) / this.#up);
    const drop = nextBase - this.#half + 1 - this.#bufStart;
    if (drop <= 0) return;
    this.#buf.copyWithin(0, drop, this.#bufLength);
    this.#bufLength -= drop;
    this.#bufStart += drop;
  }
}

/** Resamples a whole recording to 16 kHz. */
export function resampleTo16k(samples: Float32Array, inputRate: number): Float32Array {
  if (inputRate === SAMPLE_RATE) return samples;
  const resampler = new Resampler(inputRate);
  const body = resampler.process(samples);
  const tail = resampler.flush();
  const out = new Float32Array(body.length + tail.length);
  out.set(body, 0);
  out.set(tail, body.length);
  return out;
}

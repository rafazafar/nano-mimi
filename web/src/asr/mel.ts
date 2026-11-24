import type { HaasConfig } from "./config";

const PREEMPHASIS = Math.fround(0.97);
const LOG_ZERO_GUARD = 2 ** -24;
const NORMALIZE_EPS = 1e-5;

/** Encoder input: `[nMels, padded]` row-major, zero past `frames`. */
export interface LogMel {
  readonly mel: Float32Array;
  /** Time axis length, a multiple of `padTo`. */
  readonly padded: number;
  /** Valid frames, NeMo's `get_seq_len`. Zero means the clip is shorter than one hop. */
  readonly frames: number;
}

/**
 * NeMo's inference log-mel, a port of haas_ja_local `features.log_mel`: pre-emphasis,
 * centred zero-padded STFT, power, mel filterbank, log, then per-mel normalisation over
 * the valid frames with the unbiased standard deviation.
 *
 * The real `nFft`-point FFT runs as one `nFft/2`-point complex FFT plus a split step,
 * the window's zero taps are skipped, and each mel filter only sums its nonzero bins.
 */
export class MelFrontEnd {
  readonly #cfg: HaasConfig;
  /** Window taps centred in `nFft`, as torch.stft places them: nonzero on `[#left, #left + winLength)`. */
  readonly #window: Float64Array;
  readonly #left: number;
  /** Each mel filter's nonzero bins: weights packed in `#weights` from `#offset[m]`, covering bins `#first[m]` to `#first[m] + #count[m]`. */
  readonly #first: Uint16Array;
  readonly #count: Uint16Array;
  readonly #offset: Uint32Array;
  readonly #weights: Float64Array;
  /** Half-size complex FFT tables. */
  readonly #rev: Uint16Array;
  readonly #twr: Float64Array;
  readonly #twi: Float64Array;
  /** Split-step twiddles, `exp(-2πik/nFft)` for k in [0, nFft/2]. */
  readonly #spr: Float64Array;
  readonly #spi: Float64Array;

  /** `window` is the checkpoint's `(winLength,)` window, `fb` its `[nMels, nFft/2+1]` filterbank. */
  constructor(cfg: HaasConfig, window: Float32Array, fb: Float32Array) {
    const n = cfg.nFft;
    const bins = n / 2 + 1;
    if (window.length !== cfg.winLength) throw new Error(`window has ${window.length} taps, expected ${cfg.winLength}`);
    if (fb.length !== cfg.nMels * bins) throw new Error(`filterbank has ${fb.length} values, expected ${cfg.nMels * bins}`);
    this.#cfg = cfg;
    this.#left = (n - cfg.winLength) / 2;
    this.#window = Float64Array.from(window);

    this.#first = new Uint16Array(cfg.nMels);
    this.#count = new Uint16Array(cfg.nMels);
    this.#offset = new Uint32Array(cfg.nMels);
    const packed: number[] = [];
    for (let m = 0; m < cfg.nMels; m++) {
      const row = fb.subarray(m * bins, (m + 1) * bins);
      let lo = 0;
      while (lo < bins && row[lo] === 0) lo++;
      let hi = bins;
      while (hi > lo && row[hi - 1] === 0) hi--;
      this.#first[m] = lo;
      this.#count[m] = hi - lo;
      this.#offset[m] = packed.length;
      for (let k = lo; k < hi; k++) packed.push(row[k]!);
    }
    this.#weights = Float64Array.from(packed);

    const half = n / 2;
    const bits = Math.log2(half);
    this.#rev = new Uint16Array(half);
    for (let i = 0; i < half; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.#rev[i] = r;
    }
    this.#twr = new Float64Array(half / 2);
    this.#twi = new Float64Array(half / 2);
    for (let i = 0; i < half / 2; i++) {
      this.#twr[i] = Math.cos((-2 * Math.PI * i) / half);
      this.#twi[i] = Math.sin((-2 * Math.PI * i) / half);
    }
    this.#spr = new Float64Array(half + 1);
    this.#spi = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      this.#spr[k] = Math.cos((-2 * Math.PI * k) / n);
      this.#spi[k] = Math.sin((-2 * Math.PI * k) / n);
    }
  }

  compute(samples: Float32Array): LogMel {
    const { nFft, hopLength, nMels, padTo, winLength } = this.#cfg;
    const n = samples.length;
    const frames = n <= 0 ? 0 : Math.floor((n + 2 * (nFft / 2) - nFft) / hopLength);
    if (frames === 0) return { mel: new Float32Array(0), padded: 0, frames: 0 };
    const pad = nFft / 2;
    const x = new Float32Array(n + 2 * pad);
    x[pad] = samples[0]!;
    for (let i = 1; i < n; i++) x[pad + i] = samples[i]! - PREEMPHASIS * samples[i - 1]!;

    const stft = frames + 1;
    const padded = Math.ceil(stft / padTo) * padTo;
    const half = nFft / 2;
    const left = this.#left;
    const win = this.#window;
    const re = new Float64Array(half);
    const im = new Float64Array(half);
    const pw = new Float64Array(half + 1);
    const logm = new Float64Array(nMels * stft);
    const first = this.#first;
    const count = this.#count;
    const offset = this.#offset;
    const weights = this.#weights;
    for (let f = 0; f < stft; f++) {
      // Even samples go to re, odd to im; Math.fround matches numpy's float32 frames * window.
      re.fill(0);
      im.fill(0);
      const o = f * hopLength + left;
      for (let i = 0; i < winLength; i++) {
        const j = left + i;
        const v = Math.fround(x[o + i]! * win[i]!);
        if (j & 1) im[j >> 1] = v;
        else re[j >> 1] = v;
      }
      this.#fftHalf(re, im);
      this.#power(re, im, pw);
      for (let m = 0; m < nMels; m++) {
        let s = 0;
        const k0 = first[m]!;
        const w0 = offset[m]!;
        for (let k = 0, c = count[m]!; k < c; k++) s += weights[w0 + k]! * pw[k0 + k]!;
        logm[m * stft + f] = Math.fround(Math.log(Math.fround(s) + LOG_ZERO_GUARD));
      }
    }

    const mel = new Float32Array(nMels * padded);
    if (frames >= 2) {
      for (let m = 0; m < nMels; m++) {
        const base = m * stft;
        let mean = 0;
        for (let f = 0; f < frames; f++) mean += logm[base + f]!;
        mean /= frames;
        let v = 0;
        for (let f = 0; f < frames; f++) {
          const d = logm[base + f]! - mean;
          v += d * d;
        }
        const scale = 1 / (Math.sqrt(v / (frames - 1)) + NORMALIZE_EPS);
        const row = m * padded;
        for (let f = 0; f < frames; f++) mel[row + f] = (logm[base + f]! - mean) * scale;
      }
    }
    return { mel, padded, frames };
  }

  /** In-place radix-2 complex FFT of size nFft/2. */
  #fftHalf(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    const rev = this.#rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        let t = re[i]!;
        re[i] = re[j]!;
        re[j] = t;
        t = im[i]!;
        im[i] = im[j]!;
        im[j] = t;
      }
    }
    const twr = this.#twr;
    const twi = this.#twi;
    for (let size = 2; size <= n; size <<= 1) {
      const h = size >> 1;
      const step = n / size;
      for (let s = 0; s < n; s += size) {
        for (let k = 0; k < h; k++) {
          const wr = twr[k * step]!;
          const wi = twi[k * step]!;
          const a = s + k;
          const b = a + h;
          const tr = re[b]! * wr - im[b]! * wi;
          const ti = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
  }

  /** |X[k]|² for k in [0, nFft/2] from the half-size FFT Z of the packed real frame, as float32 like numpy. */
  #power(zr: Float64Array, zi: Float64Array, pw: Float64Array): void {
    const half = zr.length;
    const spr = this.#spr;
    const spi = this.#spi;
    for (let k = 0; k <= half; k++) {
      const a = k === half ? 0 : k;
      const b = k === 0 ? 0 : half - k;
      const er = 0.5 * (zr[a]! + zr[b]!);
      const ei = 0.5 * (zi[a]! - zi[b]!);
      const or = 0.5 * (zi[a]! + zi[b]!);
      const oi = -0.5 * (zr[a]! - zr[b]!);
      const c = spr[k]!;
      const s = spi[k]!;
      const xr = er + c * or - s * oi;
      const xi = ei + c * oi + s * or;
      pw[k] = Math.fround(xr * xr + xi * xi);
    }
  }
}

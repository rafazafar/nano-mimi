export const SAMPLE_RATE = 16_000;
export const WINDOW = 512;

export interface VadTuning {
  readonly threshold: number;
  readonly minSilenceMs: number;
  readonly speechPadMs: number;
  readonly minSpeechMs: number;
  readonly minSpeechS: number;
  readonly maxEmitS: number;
}

/** The values `config.apply_live_vad_overrides()` leaves on the `fast` latency preset. */
export const LIVE_TUNING: VadTuning = {
  threshold: 0.35,
  minSilenceMs: 400,
  speechPadMs: 80,
  minSpeechMs: 250,
  minSpeechS: 0.6,
  maxEmitS: 15,
};

const AMP_FLOOR = Math.fround(0.01);
const TARGET_RMS = 0.1;
const MIN_EMIT_RMS = 10 ** (-70 / 20);
const MIN_EMIT_SNR = 10 ** (3 / 20);
const NOISE_FLOOR_MIN = 1e-5;
const NOISE_FLOOR_RISE = 10 ** (((3 / 20) * WINDOW) / SAMPLE_RATE);

/**
 * A chunk the state machine cut from the stream. `start` and `end` are sample
 * positions of the raw chunk (pads included). `samples` is the gained and
 * trimmed audio to transcribe, or null when a post-emit rule filtered it.
 */
export interface Candidate {
  readonly start: number;
  readonly end: number;
  readonly vadWaitS: number;
  readonly samples: Float32Array | null;
}

export interface WindowResult {
  readonly candidates: readonly Candidate[];
  /** The model's recurrent state must be cleared before the next window is scored. */
  readonly resetScorer: boolean;
}

function rms(audio: Float32Array): number {
  if (audio.length === 0) return 0;
  let sum = 0;
  for (const v of audio) sum += v * v;
  return Math.sqrt(sum / audio.length);
}

function trimTrailingSilence(audio: Float32Array): Float32Array {
  let last = -1;
  for (let i = audio.length - 1; i >= 0; i--) {
    if (Math.abs(audio[i] as number) >= AMP_FLOOR) {
      last = i;
      break;
    }
  }
  if (last < 0) return audio.subarray(0, 0);
  const pad = Math.min(Math.trunc(SAMPLE_RATE / 50), audio.length - last - 1);
  return audio.subarray(0, Math.min(audio.length, last + 1 + pad));
}

function concat(parts: readonly Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Samples that came from the stream starting at `start`. */
class Run {
  #parts: Float32Array[] = [];
  length = 0;
  start = 0;

  append(at: number, part: Float32Array): void {
    if (this.length === 0) this.start = at;
    this.#parts.push(part);
    this.length += part.length;
  }

  take(): Float32Array {
    const out = concat(this.#parts, this.length);
    this.clear();
    return out;
  }

  clear(): void {
    this.#parts = [];
    this.length = 0;
  }
}

/**
 * Port of `SileroVAD.feed` / `_emit` from `src/mimivox/vad.py`: speech
 * probabilities for consecutive 512-sample windows in, utterances out. It never
 * sees the model, so feeding it is deterministic for any slicing of the stream.
 */
export class VadStateMachine {
  readonly #tuning: VadTuning;
  readonly #padSamples: number;
  readonly #minOpenWindows: number;
  readonly #minSilenceWindows: number;
  readonly #minSpeechSamples: number;
  readonly #maxEmitSamples: number;

  #position = 0;
  #inSpeech = false;
  #speech = new Run();
  #silence = new Run();
  #silenceWindows = 0;
  #speechWindows = 0;
  #pending = new Run();
  #preroll: Float32Array = new Float32Array(0);
  #noiseFloor = Infinity;

  constructor(tuning: VadTuning) {
    this.#tuning = tuning;
    this.#padSamples = Math.max(0, Math.trunc((SAMPLE_RATE * tuning.speechPadMs) / 1000));
    this.#minOpenWindows = Math.max(
      1,
      Math.trunc((SAMPLE_RATE * tuning.minSpeechMs) / 1000 / WINDOW),
    );
    this.#minSilenceWindows = Math.max(
      1,
      Math.trunc((SAMPLE_RATE * tuning.minSilenceMs) / 1000 / WINDOW),
    );
    this.#minSpeechSamples = Math.trunc(SAMPLE_RATE * tuning.minSpeechS);
    this.#maxEmitSamples = Math.trunc(SAMPLE_RATE * tuning.maxEmitS);
  }

  /** Consumes the next window of the stream together with the model's P(speech) for it. */
  push(win: Float32Array, prob: number): WindowResult {
    const at = this.#position;
    this.#position += WINDOW;
    this.#trackNoiseFloor(win);
    const isSpeech = prob >= this.#tuning.threshold;
    const candidates: Candidate[] = [];
    let resetScorer = false;

    if (!this.#inSpeech) {
      if (isSpeech) {
        this.#speechWindows++;
        this.#pending.append(at, win.slice());
        if (this.#speechWindows >= this.#minOpenWindows) this.#open();
      } else {
        this.#speechWindows = 0;
        this.#pending.clear();
        this.#pushPreroll(win);
      }
      return { candidates, resetScorer };
    }

    if (isSpeech) {
      if (this.#silence.length > 0) {
        this.#speech.append(this.#silence.start, this.#silence.take());
        this.#silenceWindows = 0;
      }
      this.#speech.append(at, win.slice());
      if (this.#speech.length >= this.#maxEmitSamples) {
        const start = this.#speech.start;
        candidates.push(...this.#splitAndEmit(start, this.#speech.take(), 0));
      }
    } else {
      this.#silence.append(at, win.slice());
      this.#silenceWindows++;
      if (this.#silenceWindows >= this.#minSilenceWindows) {
        candidates.push(...this.#close((this.#silenceWindows * WINDOW) / SAMPLE_RATE));
        resetScorer = true;
      }
    }
    return { candidates, resetScorer };
  }

  /** Emits any utterance still open at end of stream. */
  flush(): WindowResult {
    if (!this.#inSpeech || this.#speech.length === 0) {
      this.#speech.clear();
      this.#silence.clear();
      this.#pending.clear();
      this.#inSpeech = false;
      return { candidates: [], resetScorer: false };
    }
    return {
      candidates: this.#close((this.#silenceWindows * WINDOW) / SAMPLE_RATE),
      resetScorer: true,
    };
  }

  #open(): void {
    const firstPending = this.#pending.start;
    const preroll = this.#preroll;
    const pending = this.#pending.take();
    this.#inSpeech = true;
    this.#speech.clear();
    this.#speech.append(
      firstPending - preroll.length,
      concat([preroll, pending], preroll.length + pending.length),
    );
    this.#silence.clear();
    this.#silenceWindows = 0;
    this.#preroll = new Float32Array(0);
  }

  #pushPreroll(win: Float32Array): void {
    const pad = this.#padSamples;
    if (pad <= 0) return;
    const keep = Math.min(pad, this.#preroll.length + win.length);
    const out = new Float32Array(keep);
    const fromWin = Math.min(keep, win.length);
    out.set(win.subarray(win.length - fromWin), keep - fromWin);
    out.set(this.#preroll.subarray(this.#preroll.length - (keep - fromWin)), 0);
    this.#preroll = out;
  }

  #trackNoiseFloor(win: Float32Array): void {
    const level = Math.max(rms(win), NOISE_FLOOR_MIN);
    this.#noiseFloor = Math.min(level, this.#noiseFloor * NOISE_FLOOR_RISE);
  }

  #emit(start: number, chunk: Float32Array, vadWaitS: number): Candidate {
    const end = start + chunk.length;
    const filtered: Candidate = { start, end, vadWaitS, samples: null };
    const level = rms(chunk);
    if (level < Math.max(MIN_EMIT_RMS, this.#noiseFloor * MIN_EMIT_SNR)) return filtered;
    let peak = 0;
    for (const v of chunk) peak = Math.max(peak, Math.abs(v));
    const gain = Math.fround(Math.max(1, Math.min(TARGET_RMS / level, 0.99 / peak)));
    const gained = new Float32Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) gained[i] = (chunk[i] as number) * gain;
    const trimmed = trimTrailingSilence(gained);
    if (trimmed.length < this.#minSpeechSamples) return filtered;
    return { start, end, vadWaitS, samples: trimmed };
  }

  #splitAndEmit(start: number, buf: Float32Array, vadWaitS: number): Candidate[] {
    const out: Candidate[] = [];
    for (let offset = 0; offset < buf.length; offset += this.#maxEmitSamples) {
      const sub = buf.subarray(offset, offset + this.#maxEmitSamples);
      if (sub.length >= this.#minSpeechSamples) out.push(this.#emit(start + offset, sub, vadWaitS));
    }
    return out;
  }

  #close(vadWaitS: number): Candidate[] {
    const pad = this.#padSamples;
    const speechStart = this.#speech.length > 0 ? this.#speech.start : this.#silence.start;
    const speech = this.#speech.take();
    const silence = this.#silence.take();
    const trailing =
      pad > 0 ? silence.subarray(0, Math.min(pad, silence.length)) : silence.subarray(0, 0);
    const chunk = concat([speech, trailing], speech.length + trailing.length);

    let out: Candidate[];
    const first = this.#emit(speechStart, chunk, vadWaitS);
    if (first.samples !== null && first.samples.length > this.#maxEmitSamples) {
      out = this.#splitAndEmit(speechStart, first.samples, vadWaitS);
    } else {
      out = [first];
    }
    this.#silenceWindows = 0;
    this.#speechWindows = 0;
    this.#pending.clear();
    this.#inSpeech = false;
    this.#preroll = new Float32Array(0);
    return out;
  }
}

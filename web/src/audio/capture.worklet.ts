import { POST_SAMPLES, type WorkletMessage, type WorkletRequest } from "./captureProtocol";
import { Resampler } from "./resampler";

declare const sampleRate: number;
declare const currentFrame: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const RENDER_QUANTUM = 128;

class CaptureProcessor extends AudioWorkletProcessor {
  readonly #resampler = new Resampler(sampleRate);
  readonly #block = new Float32Array(POST_SAMPLES);
  #filled = 0;
  #quanta = 0;
  #ticks = 0;
  #slowCalls = 0;
  #maxTicks = 0;
  #emptyInputs = 0;
  #skipped = 0;
  #lastFrame = -1;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<WorkletRequest>) => {
      if (event.data.type === "stats") this.#postStats();
    };
  }

  process(inputs: Float32Array[][]): boolean {
    // Chrome renders one quantum, then idles for ~190 ms while the device starts.
    if (this.#quanta >= 2) {
      this.#skipped += Math.round((currentFrame - this.#lastFrame) / RENDER_QUANTUM) - 1;
    }
    this.#lastFrame = currentFrame;
    const channel = inputs[0]?.[0];
    if (channel === undefined) {
      this.#emptyInputs++;
      return true;
    }
    const started = Date.now();
    this.#post(this.#resampler.process(channel));
    const ticks = Date.now() - started;
    this.#quanta++;
    this.#ticks += ticks;
    if (ticks >= 2) this.#slowCalls++;
    this.#maxTicks = Math.max(this.#maxTicks, ticks);
    return true;
  }

  #post(samples: Float32Array): void {
    let at = 0;
    while (at < samples.length) {
      const take = Math.min(POST_SAMPLES - this.#filled, samples.length - at);
      this.#block.set(samples.subarray(at, at + take), this.#filled);
      this.#filled += take;
      at += take;
      if (this.#filled === POST_SAMPLES) {
        const message: WorkletMessage = { type: "samples", samples: this.#block.slice() };
        this.port.postMessage(message, [message.samples.buffer]);
        this.#filled = 0;
      }
    }
  }

  #postStats(): void {
    const message: WorkletMessage = {
      type: "stats",
      quanta: this.#quanta,
      sampleRate,
      meanMs: this.#quanta === 0 ? 0 : this.#ticks / this.#quanta,
      slowCalls: this.#slowCalls,
      maxTicks: this.#maxTicks,
      emptyInputs: this.#emptyInputs,
      skippedQuanta: this.#skipped,
    };
    this.port.postMessage(message);
  }
}

registerProcessor("mimivox-capture", CaptureProcessor);

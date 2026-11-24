import type { JaText } from "../core/types";
import type { Transcript } from "./haas";
import type { AsrDevice, AsrInit, AsrRequest, AsrResponse } from "./protocol";

interface Pending {
  readonly resolve: (t: Transcript) => void;
  readonly reject: (e: Error) => void;
}

/** Main-thread handle on the ASR worker. All model work happens in the worker. */
export class AsrClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;

  private constructor(
    worker: Worker,
    readonly device: AsrDevice,
    readonly loadMs: number,
  ) {
    this.#worker = worker;
    worker.onmessage = (e: MessageEvent<AsrResponse>) => this.#settle(e.data);
    worker.onerror = (e) => this.#failAll(new Error(e.message));
  }

  /** Starts the worker and loads the models from the model store; rejects if init fails. */
  static create(init: AsrInit): Promise<AsrClient> {
    const worker = new Worker(new URL("./asr.worker.ts", import.meta.url), { type: "module", name: "asr" });
    return new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<AsrResponse>) => {
        const msg = e.data;
        if (msg.type === "ready") resolve(new AsrClient(worker, msg.device, msg.loadMs));
        else if (msg.type === "error") {
          worker.terminate();
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (e) => {
        worker.terminate();
        reject(new Error(e.message));
      };
      const req: AsrRequest = { type: "init", ...init };
      worker.postMessage(req);
    });
  }

  /** 16 kHz mono samples to Japanese text; empty when the clip held no speech content. */
  async transcribe(samples: Float32Array): Promise<JaText> {
    return (await this.transcribeDetailed(samples)).text;
  }

  /** The text plus the raw decode, token ids and per-stage timing. */
  transcribeDetailed(samples: Float32Array): Promise<Transcript> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const req: AsrRequest = { type: "transcribe", id, samples };
      this.#worker.postMessage(req);
    });
  }

  terminate(): void {
    this.#worker.terminate();
    this.#failAll(new Error("ASR worker terminated"));
  }

  #failAll(err: Error): void {
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }

  #settle(msg: AsrResponse): void {
    if (msg.type === "ready" || msg.id === null) return;
    const p = this.#pending.get(msg.id);
    if (p === undefined) return;
    this.#pending.delete(msg.id);
    if (msg.type === "transcript") p.resolve(msg.transcript);
    else p.reject(new Error(msg.message));
  }
}

import type { PairId } from "../core/pair";
import type { ContextTurn, JaText } from "../core/types";
import type { Manifest } from "../models/types";
import type { LoadInfo, MtEvent, MtOutcome, MtRequest } from "./protocol";

export interface TranslateOptions {
  /** Best-effort partial: capped at 48 tokens, skipped while CAT is busy, aborted by a final. */
  readonly preview: boolean;
  /** Raw text deltas of the first pass as CAT produces them. */
  readonly onToken?: (delta: string) => void;
}

export interface Translation {
  readonly outcome: Promise<MtOutcome>;
  cancel(): void;
}

interface Pending {
  readonly onToken: ((delta: string) => void) | undefined;
  readonly resolve: (outcome: MtOutcome) => void;
  readonly reject: (error: Error) => void;
}

/** Page-side handle on the MT worker. */
export class MtClient {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  private constructor(
    private readonly worker: Worker,
    readonly load: LoadInfo,
  ) {
    worker.addEventListener("message", (e: MessageEvent<MtEvent>) => this.onEvent(e.data));
  }

  /** Starts the worker for `pair` and loads CAT from the model store. The files must already be downloaded. */
  static async start(manifest: Manifest, modelId: string, pair: PairId): Promise<MtClient> {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const load = await new Promise<LoadInfo>((resolve, reject) => {
      const onMessage = (e: MessageEvent<MtEvent>): void => {
        if (e.data.type === "ready") resolve(e.data.load);
        else if (e.data.type === "init-failed") reject(new Error(e.data.message));
        else return;
        worker.removeEventListener("message", onMessage);
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", (e) => reject(new Error(e.message)), { once: true });
      const init: MtRequest = { type: "init", manifest, modelId, pair };
      worker.postMessage(init);
    });
    return new MtClient(worker, load);
  }

  translate(ja: JaText, context: readonly ContextTurn[], options: TranslateOptions): Translation {
    const id = this.nextId++;
    const outcome = new Promise<MtOutcome>((resolve, reject) => {
      this.pending.set(id, { onToken: options.onToken, resolve, reject });
    });
    this.send({ type: "translate", id, ja, context, preview: options.preview });
    return { outcome, cancel: () => this.send({ type: "cancel", id }) };
  }

  terminate(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("the MT worker was terminated"));
    this.pending.clear();
  }

  private send(request: MtRequest): void {
    this.worker.postMessage(request);
  }

  private onEvent(event: MtEvent): void {
    if (event.type === "ready" || event.type === "init-failed") return;
    const p = this.pending.get(event.id);
    if (p === undefined) return;
    switch (event.type) {
      case "token":
        p.onToken?.(event.delta);
        return;
      case "done":
        p.resolve({ kind: "done", result: event.result });
        break;
      case "skipped":
        p.resolve({ kind: "skipped" });
        break;
      case "cancelled":
        p.resolve({ kind: "cancelled" });
        break;
      case "failed":
        p.reject(new Error(event.message));
        break;
    }
    this.pending.delete(event.id);
  }
}

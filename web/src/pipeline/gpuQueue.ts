/**
 * ASR and CAT share one GPU. Run together they contend for memory bandwidth and both slow down, so every GPU
 * job goes through this queue and one runs at a time (the Python pipeline's shared MLX lock, with priorities).
 *
 * Priority, highest first:
 * 1. `mt-final`: a finished line whose English the user is waiting for. It is the shortest job left in the
 *    pipeline for an utterance that already cleared ASR, so serving it first minimizes speech-end-to-English.
 * 2. `asr`: the next utterance's decode. It waits at most one translation (about 0.4 s), and the ASR queue
 *    coalesces anything that piles up behind it.
 * 3. `mt-preview`: speculative. It is never queued: it runs only on an idle GPU, is skipped when anything
 *    runs or waits, and a running one is aborted the moment any other job arrives.
 *
 * Jobs are not otherwise preemptive: an ASR decode or a final translation always runs to the end.
 */
export type GpuPriority = "mt-final" | "asr" | "mt-preview";

const RANK: Readonly<Record<GpuPriority, number>> = { "mt-final": 0, asr: 1, "mt-preview": 2 };

export type JobOutcome<T> =
  | { readonly kind: "done"; readonly value: T }
  /** Aborted by `cancel()` or preempted, whether or not the work had started. */
  | { readonly kind: "cancelled" }
  /** A preview offered to a busy GPU. */
  | { readonly kind: "skipped" };

export interface GpuJob<T> {
  /** Rejects when `run` threw and the job was not cancelled. */
  readonly outcome: Promise<JobOutcome<T>>;
  cancel(): void;
}

export interface GpuSnapshot {
  readonly running: GpuPriority | null;
  readonly waiting: readonly GpuPriority[];
}

interface Entry {
  readonly priority: GpuPriority;
  readonly run: (signal: AbortSignal) => Promise<unknown>;
  readonly ctrl: AbortController;
  readonly settle: (outcome: JobOutcome<unknown>) => void;
  readonly fail: (error: unknown) => void;
}

export class GpuQueue {
  #running: Entry | null = null;
  readonly #waiting: Entry[] = [];

  snapshot(): GpuSnapshot {
    return { running: this.#running?.priority ?? null, waiting: this.#waiting.map((e) => e.priority) };
  }

  /** `run` receives a signal that aborts when the job is cancelled or preempted; it should stop promptly. */
  submit<T>(priority: GpuPriority, run: (signal: AbortSignal) => Promise<T>): GpuJob<T> {
    const ctrl = new AbortController();
    let entry!: Entry;
    const outcome = new Promise<JobOutcome<T>>((settle, fail) => {
      entry = { priority, run, ctrl, settle: settle as Entry["settle"], fail };
    });
    const job: GpuJob<T> = { outcome, cancel: () => this.#cancel(entry) };

    if (priority === "mt-preview") {
      if (this.#running !== null || this.#waiting.length > 0) entry.settle({ kind: "skipped" });
      else this.#start(entry);
      return job;
    }
    const at = this.#waiting.findIndex((e) => RANK[e.priority] > RANK[priority]);
    this.#waiting.splice(at === -1 ? this.#waiting.length : at, 0, entry);
    if (this.#running === null) this.#startNext();
    else if (this.#running.priority === "mt-preview") this.#running.ctrl.abort();
    return job;
  }

  #cancel(entry: Entry): void {
    if (this.#running === entry) {
      entry.ctrl.abort();
      return;
    }
    const at = this.#waiting.indexOf(entry);
    if (at === -1) return;
    this.#waiting.splice(at, 1);
    entry.settle({ kind: "cancelled" });
  }

  #startNext(): void {
    const next = this.#waiting.shift();
    if (next !== undefined) this.#start(next);
  }

  #start(entry: Entry): void {
    this.#running = entry;
    const finish = (): void => {
      this.#running = null;
      this.#startNext();
    };
    this.#invoke(entry).then(
      (value) => {
        finish();
        entry.settle(entry.ctrl.signal.aborted ? { kind: "cancelled" } : { kind: "done", value });
      },
      (error: unknown) => {
        finish();
        if (entry.ctrl.signal.aborted) entry.settle({ kind: "cancelled" });
        else entry.fail(error);
      },
    );
  }

  /** A job that throws before returning a promise must fail its own outcome, not leave the GPU marked busy. */
  #invoke(entry: Entry): Promise<unknown> {
    try {
      return entry.run(entry.ctrl.signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

import type { ContextTurn } from "../core/types";
import type { MtEvent, MtResult } from "./protocol";

export interface Job {
  readonly id: number;
  readonly ja: string;
  readonly context: readonly ContextTurn[];
  readonly preview: boolean;
}

export type RunJob = (job: Job, signal: AbortSignal, onToken: (delta: string) => void) => Promise<MtResult>;

type SchedulerEvent = Extract<MtEvent, { type: "done" | "skipped" | "cancelled" | "failed" | "token" }>;

/**
 * One CAT, one job at a time. The policy follows translate.py's cat_lock:
 * a preview is best-effort and is skipped while anything runs or waits; a
 * final waits its turn behind other finals. Unlike MLX, a running preview can
 * be stopped, so a final aborts it instead of waiting out its 48 tokens.
 */
export class MtScheduler {
  private running: { readonly job: Job; readonly ctrl: AbortController } | null = null;
  private readonly waiting: Job[] = [];

  constructor(
    private readonly run: RunJob,
    private readonly emit: (event: SchedulerEvent) => void,
  ) {}

  submit(job: Job): void {
    if (job.preview) {
      if (this.running !== null || this.waiting.length > 0) this.emit({ type: "skipped", id: job.id });
      else this.start(job);
      return;
    }
    if (this.running === null) {
      this.start(job);
      return;
    }
    this.waiting.push(job);
    if (this.running.job.preview) this.running.ctrl.abort();
  }

  cancel(id: number): void {
    if (this.running?.job.id === id) {
      this.running.ctrl.abort();
      return;
    }
    const index = this.waiting.findIndex((j) => j.id === id);
    if (index === -1) return;
    this.waiting.splice(index, 1);
    this.emit({ type: "cancelled", id });
  }

  private start(job: Job): void {
    const ctrl = new AbortController();
    this.running = { job, ctrl };
    const onToken = (delta: string): void => {
      if (!ctrl.signal.aborted) this.emit({ type: "token", id: job.id, delta });
    };
    this.run(job, ctrl.signal, onToken).then(
      (result) => this.finish(ctrl.signal.aborted ? { type: "cancelled", id: job.id } : { type: "done", id: job.id, result }),
      (error: unknown) =>
        this.finish(
          ctrl.signal.aborted
            ? { type: "cancelled", id: job.id }
            : { type: "failed", id: job.id, message: error instanceof Error ? error.message : String(error) },
        ),
    );
  }

  private finish(outcome: SchedulerEvent): void {
    this.running = null;
    this.emit(outcome);
    const next = this.waiting.shift();
    if (next !== undefined) this.start(next);
  }
}

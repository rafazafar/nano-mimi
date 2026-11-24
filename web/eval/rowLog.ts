import type { PipelineEvent } from "../src/pipeline";

/**
 * One caption row in the shape of the Python pipeline's log rows, so `scripts/eval/web_eval.py` can hand the
 * rows straight to the scoring code `run_eval.py` uses. Only the fields that scoring reads are here.
 */
export interface EvalRow {
  readonly id: number;
  readonly ja: string;
  readonly en: string;
  /** Start of the utterance on the audio clock, as `timeline_s` in the Python log. */
  readonly timeline_s: number;
  readonly duration_s: number;
  readonly vad_wait_s: number;
  readonly queue_wait_s: number;
  readonly asr_latency_s: number;
  readonly translate_latency_s: number;
  readonly merged_ids: readonly number[];
  readonly source: string;
}

export interface SessionRecord {
  readonly rows: readonly EvalRow[];
  /** Rows that began translating and never settled. */
  readonly unsettled: number;
  readonly errors: readonly string[];
  readonly maxBacklogS: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Builds a session's rows from the pipeline's events, with the Python log's rules. A fragment that merges
 * back into an earlier row rewrites its text and span and adds its translation time to the row's, but keeps
 * the row's VAD wait, queue wait and ASR time. The row's perceived latency is then the sum of the four.
 */
export class RowLog {
  readonly #rows = new Map<number, Mutable<EvalRow>>();
  readonly #pending = new Set<number>();
  readonly #errors: string[] = [];
  #maxBacklogS = 0;

  apply(event: PipelineEvent): void {
    switch (event.kind) {
      case "translating":
        this.#pending.add(event.id);
        return;
      case "final":
        this.#pending.delete(event.id);
        this.#rows.set(event.id, {
          id: event.id,
          ja: event.ja,
          en: event.en,
          timeline_s: event.timelineS,
          duration_s: event.durationS,
          vad_wait_s: event.timing.vadWaitS,
          queue_wait_s: event.timing.queueWaitS,
          asr_latency_s: event.timing.asrS,
          translate_latency_s: event.timing.mtS,
          merged_ids: [],
          source: event.source,
        });
        return;
      case "revision": {
        const row = this.#rows.get(event.targetId);
        if (row === undefined) return;
        row.ja = event.ja;
        row.en = event.en;
        row.duration_s = event.durationS;
        row.translate_latency_s += event.timing.mtS;
        row.merged_ids = event.mergedIds;
        row.source = event.source;
        return;
      }
      case "backlog":
        this.#maxBacklogS = Math.max(this.#maxBacklogS, event.backlogS);
        return;
      case "error":
        this.#errors.push(event.detail);
        return;
      case "partial_ja":
      case "partial_en":
      case "revising":
      case "revision_failed":
      case "en_token":
        return;
    }
  }

  snapshot(): SessionRecord {
    return {
      rows: [...this.#rows.values()].sort((a, b) => a.id - b.id),
      unsettled: this.#pending.size,
      errors: [...this.#errors],
      maxBacklogS: this.#maxBacklogS,
    };
  }
}

/**
 * How `process()` behaved over the render quanta since capture started.
 *
 * AudioWorkletGlobalScope has no `performance`, so calls are timed with
 * `Date.now()`, which ticks once per millisecond. A call of length d spans at
 * least floor(d) ticks, so `slowCalls` (calls spanning 2 or more ticks) is an
 * upper bound on the calls that took more than 2 ms. The mean is unbiased
 * because the quanta are not aligned to the tick.
 */
export interface WorkletStats {
  readonly quanta: number;
  readonly sampleRate: number;
  readonly meanMs: number;
  readonly slowCalls: number;
  readonly maxTicks: number;
  /** Quanta `process()` ran on while the source delivered no audio. */
  readonly emptyInputs: number;
  /** Render quanta the browser never delivered to `process()`. */
  readonly skippedQuanta: number;
}

export type WorkletMessage =
  | { readonly type: "samples"; readonly samples: Float32Array }
  | ({ readonly type: "stats" } & WorkletStats);

export type WorkletRequest = { readonly type: "stats" };

/** Samples the worklet posts at a time: one VAD window. */
export const POST_SAMPLES = 512;

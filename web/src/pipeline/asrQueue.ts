import type { Clock, PipelineOptions, AsrItem } from "./types";

/**
 * Merge ordered utterances into one decode: samples concatenated, the oldest enqueue time kept so lag
 * metrics stay honest, the newest audio end kept for the timeline, the longest VAD wait. Port of
 * `coalesce_asr_items`. Null when there is no audio to decode.
 */
export function coalesceItems(items: readonly AsrItem[]): AsrItem | null {
  const withAudio = items.filter((item) => item.samples.length > 0);
  if (withAudio.length === 0) return null;
  const samples = new Float32Array(withAudio.reduce((n, item) => n + item.samples.length, 0));
  let at = 0;
  for (const item of withAudio) {
    samples.set(item.samples, at);
    at += item.samples.length;
  }
  return {
    samples,
    enqueuedAtMs: Math.min(...items.map((item) => item.enqueuedAtMs)),
    audioEndS: items[items.length - 1]!.audioEndS,
    vadWaitS: Math.max(...items.map((item) => item.vadWaitS)),
  };
}

/**
 * The queue between the VAD and the ASR stage. Two policies, because the two sources need opposite things:
 *
 * - `live`: capture must never stall and the freshest speech wins, so at most `keep` utterances wait. One
 *   that arrives to a full queue is merged with everything waiting into a single decode (one larger pass
 *   beats several fixed-cost ones and loses no speech). A dequeue also merges an item that already waited
 *   `staleWaitS` with whatever sits behind it.
 * - `lossless` (file replay): nothing is merged or dropped; `enqueue` waits for room instead.
 *
 * Closing keeps queued items: `take` drains them and then returns null, so the last utterance is never lost.
 */
export class AsrQueue {
  readonly #options: PipelineOptions;
  readonly #clock: Clock;
  #pending: AsrItem[] = [];
  #closed = false;
  #takers: ((item: AsrItem | null) => void)[] = [];
  #roomWaiters: (() => void)[] = [];

  constructor(options: PipelineOptions, clock: Clock) {
    this.#options = options;
    this.#clock = clock;
  }

  /** Items waiting, oldest first. */
  pending(): readonly AsrItem[] {
    return this.#pending;
  }

  get depth(): number {
    return this.#pending.length;
  }

  /** Live: returns at once. Lossless: resolves when the item is queued. Ignored once closed. */
  async enqueue(item: AsrItem): Promise<void> {
    const policy = this.#options.queue;
    if (policy.kind === "lossless") {
      while (!this.#closed && this.#pending.length >= policy.capacity) {
        await new Promise<void>((resolve) => this.#roomWaiters.push(resolve));
      }
      if (this.#closed) return;
      this.#push(item);
      return;
    }
    if (this.#closed) return;
    if (this.#pending.length >= Math.max(1, policy.keep)) {
      const merged = coalesceItems([...this.#pending, item]);
      this.#pending = [];
      this.#push(merged ?? item);
      return;
    }
    this.#push(item);
  }

  /** The next item, or null once the queue is closed and empty. */
  async take(): Promise<AsrItem | null> {
    for (;;) {
      const next = this.#pending.shift();
      if (next !== undefined) {
        this.#roomWaiters.shift()?.();
        return this.#mergeIfStale(next);
      }
      if (this.#closed) return null;
      const item = await new Promise<AsrItem | null>((resolve) => this.#takers.push(resolve));
      if (item !== null) return this.#mergeIfStale(item);
      if (this.#pending.length === 0) return null;
    }
  }

  /** No more items will arrive. Whatever is queued is still delivered. */
  close(): void {
    this.#closed = true;
    for (const resolve of this.#roomWaiters.splice(0)) resolve();
    for (const taker of this.#takers.splice(0)) taker(null);
  }

  #push(item: AsrItem): void {
    const taker = this.#takers.shift();
    if (taker !== undefined) taker(item);
    else this.#pending.push(item);
  }

  #mergeIfStale(item: AsrItem): AsrItem {
    if (this.#options.queue.kind !== "live" || this.#pending.length === 0) return item;
    const waitedS = (this.#clock.nowMs() - item.enqueuedAtMs) / 1000;
    if (waitedS < this.#options.staleWaitS) return item;
    const merged = coalesceItems([item, ...this.#pending]);
    if (merged === null) return item;
    this.#pending = [];
    return merged;
  }
}

import type { ContextTurn, JaText } from "../core/types";
import { asEnText } from "../core/types";
import type { Translation } from "../mt/client";
import type { MtOutcome, MtResult } from "../mt/protocol";
import type { AsrEngine, AsrItem, Clock, MtEngine, PipelineEvent, TranslateOptions } from "./types";

/** Test doubles for the engines and the clock. Not imported by the app. */

export class FakeClock implements Clock {
  #now = 0;
  nowMs(): number {
    return this.#now;
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let queued promise callbacks and timers run. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export function mtResult(en: string): MtResult {
  return { en: asEnText(en), raw: en, promptLeak: false, japaneseStripped: false, numbersMismatch: false, attempts: [], kept: 0, totalMs: 0 };
}

export interface MtCall {
  readonly ja: string;
  readonly context: readonly ContextTurn[];
  readonly preview: boolean;
  cancelled: boolean;
  /** Settles the call with this English, streaming it as one token first. */
  finish(en: string): void;
  /** Settles the call as a worker would that skipped a preview. */
  skip(): void;
}

/**
 * A translator whose calls the test settles by hand, or answers itself through `auto`. `cancel()` settles a
 * pending call as cancelled, as the worker does.
 */
export class FakeMt implements MtEngine {
  readonly calls: MtCall[] = [];
  /** When it returns a string the call finishes at once; null leaves it pending. */
  auto: (call: MtCall) => string | null = () => null;

  translate(ja: JaText, context: readonly ContextTurn[], options: TranslateOptions): Translation {
    const done = deferred<MtOutcome>();
    let settled = false;
    const settleWith = (outcome: MtOutcome): void => {
      if (settled) return;
      settled = true;
      done.resolve(outcome);
    };
    const call: MtCall = {
      ja,
      context,
      preview: options.preview,
      cancelled: false,
      finish: (en) => {
        if (!settled) options.onToken?.(en);
        settleWith({ kind: "done", result: mtResult(en) });
      },
      skip: () => settleWith({ kind: "skipped" }),
    };
    this.calls.push(call);
    const answer = this.auto(call);
    if (answer !== null) queueMicrotask(() => call.finish(answer));
    return {
      outcome: done.promise,
      cancel: () => {
        call.cancelled = true;
        settleWith({ kind: "cancelled" });
      },
    };
  }

  finals(): MtCall[] {
    return this.calls.filter((c) => !c.preview);
  }

  previews(): MtCall[] {
    return this.calls.filter((c) => c.preview);
  }
}

export interface AsrCall {
  readonly samples: Float32Array;
  /** Emit a streamed segment, as a Whisper-like engine would. */
  segment(text: string): void;
  finish(text: string): void;
}

/** An ASR engine the test settles by hand, or answers through `auto` from the call's samples. */
export class FakeAsr implements AsrEngine {
  readonly calls: AsrCall[] = [];
  auto: (call: AsrCall) => string | null = () => null;

  transcribe(samples: Float32Array, onSegment: (text: JaText) => void): Promise<JaText> {
    const done = deferred<JaText>();
    const call: AsrCall = {
      samples,
      segment: (text) => onSegment(text as JaText),
      finish: (text) => done.resolve(text as JaText),
    };
    this.calls.push(call);
    const answer = this.auto(call);
    if (answer !== null) queueMicrotask(() => call.finish(answer));
    return done.promise;
  }
}

/** An utterance of `n` samples whose first sample is `tag`, so a fake ASR can tell utterances apart. */
export function item(n: number, over: Partial<AsrItem> & { tag?: number } = {}): AsrItem {
  const { tag = 0, ...rest } = over;
  const samples = new Float32Array(n);
  samples[0] = tag;
  return { samples, enqueuedAtMs: 0, audioEndS: 0, vadWaitS: 0.384, ...rest };
}

export function kinds(events: readonly PipelineEvent[]): string[] {
  return events.map((e) => e.kind);
}

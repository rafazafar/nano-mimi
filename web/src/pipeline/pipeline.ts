import { TranslationCache } from "../core/cache";
import { TranslationContext } from "../core/context";
import type { Glossary } from "../core/glossary";
import { cpLength, deduplicatePhrases, isNonContentAsr } from "../core/text";
import type { JaText } from "../core/types";
import { AsrQueue } from "./asrQueue";
import { BacklogMonitor } from "./backlog";
import { DisplayStage } from "./display";
import { GpuQueue } from "./gpuQueue";
import { PartialEnCoordinator } from "./partialEn";
import type { AsrEngine, AsrItem, Clock, EventListener, MtEngine, PipelineEvent, PipelineOptions } from "./types";

const SAMPLE_RATE = 16_000;

export interface PipelineDeps {
  readonly asr: AsrEngine;
  readonly mt: MtEngine;
  readonly clock: Clock;
  /** Read at every translation, so a glossary edit applies to the next line. */
  readonly glossary: () => Glossary;
  readonly options: PipelineOptions;
}

/**
 * ASR text that is not a caption: empty or punctuation only, or a long run over a handful of distinct
 * characters (a decode loop). Phrase loops are collapsed; if only punctuation is left the text is dropped.
 */
export function cleanAsrText(text: JaText): JaText | null {
  if (isNonContentAsr(text)) return null;
  if (cpLength(text) > 60 && new Set(text).size <= 8) return null;
  const deduped = deduplicatePhrases(text);
  return isNonContentAsr(deduped) ? null : deduped;
}

export class Pipeline {
  readonly #deps: PipelineDeps;
  readonly #gpu = new GpuQueue();
  readonly #queue: AsrQueue;
  readonly #display: DisplayStage;
  readonly #backlog = new BacklogMonitor();
  readonly #listeners = new Set<EventListener>();
  #audioNowS = 0;
  #decoding: AsrItem | null = null;
  readonly #asrLoop: Promise<void>;

  constructor(deps: PipelineDeps) {
    this.#deps = deps;
    this.#queue = new AsrQueue(deps.options, deps.clock);
    const cache = new TranslationCache();
    const context = new TranslationContext();
    const emit = (event: PipelineEvent): void => this.#emit(event);
    const coordinator = new PartialEnCoordinator({
      gpu: this.#gpu,
      mt: deps.mt,
      cache,
      context,
      glossary: deps.glossary,
      emit,
      enabled: deps.options.partialEn,
    });
    this.#display = new DisplayStage({
      gpu: this.#gpu,
      mt: deps.mt,
      cache,
      context,
      coordinator,
      glossary: deps.glossary,
      clock: deps.clock,
      emit,
      onSettled: () => this.#sampleBacklog(),
    });
    this.#asrLoop = this.#runAsr();
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The audio clock advanced to `seconds` of audio consumed. Drives the backlog figure. */
  advanceAudio(seconds: number): void {
    this.#audioNowS = seconds;
    this.#sampleBacklog();
  }

  /** Queue one utterance. Under the replay policy this waits while the queue is full. */
  async submit(item: Omit<AsrItem, "enqueuedAtMs">): Promise<void> {
    await this.#queue.enqueue({ ...item, enqueuedAtMs: this.#deps.clock.nowMs() });
    this.#sampleBacklog();
  }

  /** No more audio: decode what is queued, finish every caption, then resolve. */
  async finish(): Promise<void> {
    this.#queue.close();
    await this.#asrLoop;
    await this.#display.idle();
    this.#sampleBacklog();
  }

  reportError(detail: string): void {
    this.#emit({ kind: "error", detail });
  }

  #emit(event: PipelineEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #sampleBacklog(): void {
    const ends = [
      ...this.#queue.pending().map((item) => item.audioEndS),
      ...(this.#decoding === null ? [] : [this.#decoding.audioEndS]),
      ...this.#display.unfinishedEnds(),
    ];
    const event = this.#backlog.sample(this.#audioNowS, ends);
    if (event !== null) this.#emit(event);
  }

  async #runAsr(): Promise<void> {
    for (;;) {
      const item = await this.#queue.take();
      if (item === null) return;
      this.#decoding = item;
      this.#sampleBacklog();
      try {
        await this.#decode(item);
      } catch (error) {
        this.#emit({ kind: "error", detail: `Speech recognition failed: ${error instanceof Error ? error.message : String(error)}` });
      } finally {
        this.#decoding = null;
        this.#sampleBacklog();
      }
    }
  }

  async #decode(item: AsrItem): Promise<void> {
    const { asr, clock } = this.#deps;
    const durationS = item.samples.length / SAMPLE_RATE;
    const timelineS = Math.max(0, item.audioEndS - durationS);
    let startMs = clock.nowMs();
    const job = this.#gpu.submit("asr", () => {
      startMs = clock.nowMs();
      return asr.transcribe(item.samples, (text) => void this.#display.enqueue({ kind: "partial", text, timelineS }));
    });
    const outcome = await job.outcome;
    if (outcome.kind !== "done") return;
    const asrS = (clock.nowMs() - startMs) / 1000;
    const text = cleanAsrText(outcome.value);
    if (text === null) return;
    await this.#display.enqueue({
      kind: "final",
      text,
      timelineS,
      durationS,
      audioEndS: item.audioEndS,
      speechEndMs: item.enqueuedAtMs - item.vadWaitS * 1000,
      vadWaitS: item.vadWaitS,
      queueWaitS: Math.max(0, (startMs - item.enqueuedAtMs) / 1000),
      asrS,
    });
  }
}

import { translationCacheKey, type TranslationCache } from "../core/cache";
import type { TranslationContext } from "../core/context";
import type { Glossary } from "../core/glossary";
import { isSplitContinuation } from "../core/revision";
import type { PairId } from "../core/pair";
import { strategyFor, type PairStrategy } from "../core/strategy";
import { isMostlyEnglish, rstripChars } from "../core/text";
import type { ContextTurn, EnText, JaText } from "../core/types";
import { asEnText, asJaText } from "../core/types";
import type { GpuQueue } from "./gpuQueue";
import { prepareLine, type Line } from "./line";
import type { PartialEnCoordinator } from "./partialEn";
import type { Clock, EnSource, MtEngine, PipelineEvent, RowId, Timing } from "./types";
import { asRowId } from "./types";
import type { MtOutcome, MtResult } from "../mt/protocol";

export type DisplayInput =
  /** A decoded segment of the utterance in flight (streaming engines only). */
  | { readonly kind: "partial"; readonly text: JaText; readonly timelineS: number }
  | {
      readonly kind: "final";
      readonly text: JaText;
      readonly timelineS: number;
      readonly durationS: number;
      readonly audioEndS: number;
      /** On the pipeline clock: when the speaker stopped, so `endToEndS` counts from the real end of speech. */
      readonly speechEndMs: number;
      readonly vadWaitS: number;
      readonly queueWaitS: number;
      readonly asrS: number;
    };

type FinalInput = Extract<DisplayInput, { kind: "final" }>;

interface Utterance {
  readonly id: RowId;
  ja: JaText;
  readonly startS: number;
  endS: number;
  readonly contextBefore: readonly ContextTurn[];
  readonly mergedIds: RowId[];
}

interface Translated {
  readonly en: EnText;
  readonly source: EnSource;
}

interface Merge {
  readonly target: Utterance;
  readonly translated: Translated;
  readonly line: Line;
}

export interface DisplayDeps {
  readonly gpu: GpuQueue;
  readonly mt: MtEngine;
  readonly cache: TranslationCache;
  readonly context: TranslationContext;
  readonly coordinator: PartialEnCoordinator;
  readonly glossary: () => Glossary;
  /** Defaults to `ja-en`. */
  readonly pair?: PairId;
  readonly clock: Clock;
  readonly emit: (event: PipelineEvent) => void;
  /** Called after every input has been handled. */
  readonly onSettled: () => void;
}

/**
 * The display stage: ASR text in, caption events out, one input at a time and in order.
 *
 * A final goes normalize, glossary, passthrough (mostly-English text is shown as is, no MT), cache, then MT
 * with the last three lines as context. A VAD split is repaired here: when the previous row ended mid-sentence
 * and this fragment follows it closely, the joined JA is re-translated with the context from before the split
 * and the earlier row is revised in place.
 */
export class DisplayStage {
  readonly #deps: DisplayDeps;
  readonly #strategy: PairStrategy;
  #tail: Promise<void> = Promise.resolve();
  #queued: FinalInput[] = [];
  readonly #reached = new Map<FinalInput, () => void>();
  #current: FinalInput | null = null;
  #accum = "";
  #prev: Utterance | null = null;
  #nextId = 1;

  constructor(deps: DisplayDeps) {
    this.#deps = deps;
    this.#strategy = strategyFor(deps.pair ?? "ja-en");
  }

  /** Audio-clock ends of finals waiting or being translated, for the backlog. */
  unfinishedEnds(): readonly number[] {
    const ends = this.#queued.map((f) => f.audioEndS);
    if (this.#current !== null) ends.push(this.#current.audioEndS);
    return ends;
  }

  /**
   * Queue an input. For a final the promise resolves once its translation has been handed to the GPU queue,
   * or the line was settled without one. The ASR loop waits on it, so a final's translation is queued ahead
   * of the next utterance's decode and wins the GPU by priority instead of by arriving first.
   */
  enqueue(input: DisplayInput): Promise<void> {
    let reached = Promise.resolve();
    if (input.kind === "final") {
      this.#queued.push(input);
      reached = new Promise((resolve) => this.#reached.set(input, resolve));
    }
    this.#tail = this.#tail.then(() => this.#handle(input));
    return reached;
  }

  /** Resolves when everything enqueued so far has been handled. */
  idle(): Promise<void> {
    return this.#tail;
  }

  async #handle(input: DisplayInput): Promise<void> {
    try {
      if (input.kind === "partial") this.#partial(input);
      else {
        this.#queued.shift();
        this.#current = input;
        await this.#final(input);
      }
    } catch (error) {
      this.#deps.emit({ kind: "error", detail: `Caption failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      if (input.kind === "final") this.#release(input);
      this.#current = null;
      this.#deps.onSettled();
    }
  }

  #release(input: FinalInput): void {
    this.#reached.get(input)?.();
    this.#reached.delete(input);
  }

  #partial(input: Extract<DisplayInput, { kind: "partial" }>): void {
    this.#accum = this.#accum === "" ? input.text : `${this.#accum} ${input.text}`;
    this.#deps.emit({ kind: "partial_ja", ja: asJaText(this.#accum), timelineS: input.timelineS });
    this.#deps.coordinator.schedule(asJaText(this.#accum));
  }

  async #final(input: FinalInput): Promise<void> {
    const { coordinator, context, emit, clock } = this.#deps;
    const id = asRowId(this.#nextId++);
    const startMs = clock.nowMs();

    coordinator.cancel();
    let merge: Merge | null;
    let translated: Translated;
    let line: Line;
    try {
      merge = await this.#tryMerge(input);
      if (merge !== null) ({ translated, line } = merge);
      else {
        line = prepareLine(input.text, this.#deps.glossary(), this.#strategy);
        emit({ kind: "translating", id, timelineS: input.timelineS, ja: input.text });
        translated = await this.#translateLine(line, context.pairs(), id);
      }
    } finally {
      coordinator.resetUtterance();
    }
    const { en, source } = translated;
    const mtS = source === "mt" || source === "failed" ? (clock.nowMs() - startMs) / 1000 : 0;

    if (merge !== null) context.restore(merge.target.contextBefore);
    const contextBefore = context.pairs();
    context.add(line.sent, en);

    const timing: Timing = {
      vadWaitS: input.vadWaitS,
      queueWaitS: input.queueWaitS,
      asrS: input.asrS,
      mtS,
      perceivedS: input.vadWaitS + input.queueWaitS + input.asrS + mtS,
      endToEndS: (clock.nowMs() - input.speechEndMs) / 1000,
    };
    this.#accum = "";

    if (merge !== null) {
      const target = merge.target;
      target.ja = asJaText(target.ja + input.text);
      target.endS = input.timelineS + input.durationS;
      target.mergedIds.push(id);
      emit({
        kind: "revision",
        targetId: target.id,
        mergedIds: [...target.mergedIds],
        timelineS: target.startS,
        durationS: target.endS - target.startS,
        ja: target.ja,
        en,
        source,
        timing,
      });
      return;
    }
    emit({ kind: "final", id, timelineS: input.timelineS, durationS: input.durationS, ja: input.text, en, source, timing });
    this.#prev = {
      id,
      ja: input.text,
      startS: input.timelineS,
      endS: input.timelineS + input.durationS,
      contextBefore,
      mergedIds: [],
    };
  }

  async #tryMerge(input: FinalInput): Promise<Merge | null> {
    const prev = this.#prev;
    if (!this.#strategy.splitRepair || prev === null || !this.#continues(prev, input)) return null;
    const joined = prepareLine(asJaText(prev.ja + input.text), this.#deps.glossary(), this.#strategy);
    this.#deps.emit({ kind: "revising", targetId: prev.id, ja: joined.plain });
    const translated = await this.#translateLine(joined, prev.contextBefore, prev.id);
    if (translated.en === "") {
      this.#deps.emit({ kind: "revision_failed", targetId: prev.id });
      return null;
    }
    return { target: prev, translated, line: joined };
  }

  #continues(prev: Utterance, input: FinalInput): boolean {
    if (isMostlyEnglish(prev.ja) || isMostlyEnglish(input.text)) return false;
    return isSplitContinuation(prev.ja, input.text, input.timelineS - prev.endS);
  }

  async #translateLine(line: Line, turns: readonly ContextTurn[], rowId: RowId): Promise<Translated> {
    const { gpu, mt, cache, emit } = this.#deps;
    const { plain, sent } = line;
    if (this.#strategy.source.passthrough(plain)) return { en: asEnText(rstripChars(sent, "。")), source: "passthrough" };
    const hit = cache.lookup(sent);
    if (hit !== undefined) return { en: hit, source: "cache" };

    const job = gpu.submit("mt-final", async (signal): Promise<MtOutcome> => {
      let joined: MtResult | null = null;
      for (const segment of this.#strategy.translate.segments(sent)) {
        const translation = mt.translate(segment, turns, {
          preview: false,
          onToken: (delta) => emit({ kind: "en_token", id: rowId, delta }),
        });
        const cancel = (): void => translation.cancel();
        signal.addEventListener("abort", cancel, { once: true });
        const outcome = await translation.outcome;
        signal.removeEventListener("abort", cancel);
        if (outcome.kind !== "done") return outcome;
        joined = joined === null ? outcome.result : { ...outcome.result, en: asEnText(joined.en + outcome.result.en) };
      }
      return joined === null ? { kind: "skipped" } : { kind: "done", result: joined };
    });
    if (this.#current !== null) this.#release(this.#current);
    try {
      const outcome = await job.outcome;
      if (outcome.kind === "done" && outcome.value.kind === "done") {
        const en = outcome.value.result.en;
        if (en !== "" && translationCacheKey(sent) !== "") cache.storeFinal(sent, en);
        return { en, source: en === "" ? "failed" : "mt" };
      }
    } catch (error) {
      emit({ kind: "error", detail: "Could not translate this caption." });
      console.warn("translate failed", error);
    }
    return { en: asEnText(""), source: "failed" };
  }
}

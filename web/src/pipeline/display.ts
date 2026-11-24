import { translationCacheKey, type TranslationCache } from "../core/cache";
import type { TranslationContext } from "../core/context";
import { applyGlossary, type Glossary } from "../core/glossary";
import { isSplitContinuation } from "../core/revision";
import { isMostlyEnglish, normalizePunctuation, rstripChars } from "../core/text";
import type { ContextTurn, EnText, JaText } from "../core/types";
import { asEnText, asJaText } from "../core/types";
import type { GpuQueue } from "./gpuQueue";
import type { PartialEnCoordinator } from "./partialEn";
import type { Clock, EnSource, MtEngine, PipelineEvent, RowId, Timing } from "./types";
import { asRowId } from "./types";

/** What the ASR stage hands the display stage. */
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

/** The latest emitted row, kept so a split continuation can revise it. */
interface Utterance {
  readonly id: RowId;
  ja: JaText;
  readonly startS: number;
  endS: number;
  /** The context as it stood before this row, so a merged re-translation sees what the first half saw. */
  readonly contextBefore: readonly ContextTurn[];
  readonly mergedIds: RowId[];
}

interface Translated {
  readonly en: EnText;
  readonly source: EnSource;
}

/** A continuation that translated: the row it revises, the new English, and the glossary-applied joined JA. */
interface Merge {
  readonly target: Utterance;
  readonly translated: Translated;
  readonly jaNorm: JaText;
}

export interface DisplayDeps {
  readonly gpu: GpuQueue;
  readonly mt: MtEngine;
  readonly cache: TranslationCache;
  readonly context: TranslationContext;
  readonly coordinator: PartialEnCoordinator;
  readonly glossary: () => Glossary;
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
  #tail: Promise<void> = Promise.resolve();
  #queued: FinalInput[] = [];
  readonly #reached = new Map<FinalInput, () => void>();
  #current: FinalInput | null = null;
  #accum = "";
  #prev: Utterance | null = null;
  #nextId = 1;

  constructor(deps: DisplayDeps) {
    this.#deps = deps;
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
    const jaRaw = normalizePunctuation(input.text);
    const id = asRowId(this.#nextId++);
    const startMs = clock.nowMs();

    // A final preempts any preview of this utterance.
    coordinator.cancel();
    let merge: Merge | null;
    let translated: Translated;
    let jaNorm: JaText;
    try {
      merge = await this.#tryMerge(input);
      if (merge !== null) ({ translated, jaNorm } = merge);
      else {
        emit({ kind: "translating", id, timelineS: input.timelineS, ja: input.text });
        translated = await this.#translateLine(jaRaw, context.pairs(), id);
        jaNorm = applyGlossary(jaRaw, this.#deps.glossary());
      }
    } finally {
      coordinator.resetUtterance();
    }
    const { en, source } = translated;
    const mtS = source === "mt" || source === "failed" ? (clock.nowMs() - startMs) / 1000 : 0;

    if (merge !== null) context.restore(merge.target.contextBefore);
    const contextBefore = context.pairs();
    context.add(jaNorm, en);

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

  /**
   * The VAD split one sentence: translate the joined JA as one line, with the context as it was before the
   * first half. Null when this is not a continuation or the joined line came back empty.
   */
  async #tryMerge(input: FinalInput): Promise<Merge | null> {
    const prev = this.#prev;
    if (prev === null || !this.#continues(prev, input)) return null;
    const joinedRaw = normalizePunctuation(asJaText(prev.ja + input.text));
    this.#deps.emit({ kind: "revising", targetId: prev.id, ja: joinedRaw });
    const translated = await this.#translateLine(joinedRaw, prev.contextBefore, prev.id);
    if (translated.en === "") {
      this.#deps.emit({ kind: "revision_failed", targetId: prev.id });
      return null;
    }
    return { target: prev, translated, jaNorm: applyGlossary(joinedRaw, this.#deps.glossary()) };
  }

  /** The VAD cut one sentence in two: this fragment starts soon after the previous row ended mid-sentence. */
  #continues(prev: Utterance, input: FinalInput): boolean {
    if (isMostlyEnglish(prev.ja) || isMostlyEnglish(input.text)) return false;
    return isSplitContinuation(prev.ja, input.text, input.timelineS - prev.endS);
  }

  /** Passthrough, cache or MT for one punctuation-normalized JA line. */
  async #translateLine(jaRaw: JaText, turns: readonly ContextTurn[], rowId: RowId): Promise<Translated> {
    const { gpu, mt, cache, emit } = this.#deps;
    const jaNorm = applyGlossary(jaRaw, this.#deps.glossary());
    // Judged on the text before glossary substitution: a line that only became English because of a term
    // swap still needs MT.
    if (isMostlyEnglish(jaRaw)) return { en: asEnText(rstripChars(jaNorm, "。")), source: "passthrough" };
    const hit = cache.lookup(jaNorm);
    if (hit !== undefined) return { en: hit, source: "cache" };

    const job = gpu.submit("mt-final", async (signal) => {
      const translation = mt.translate(jaNorm, turns, {
        preview: false,
        onToken: (delta) => emit({ kind: "en_token", id: rowId, delta }),
      });
      signal.addEventListener("abort", () => translation.cancel(), { once: true });
      return translation.outcome;
    });
    if (this.#current !== null) this.#release(this.#current);
    try {
      const outcome = await job.outcome;
      if (outcome.kind === "done" && outcome.value.kind === "done") {
        const en = outcome.value.result.en;
        // An empty result is never cached: the next occurrence should get another try.
        if (en !== "" && translationCacheKey(jaNorm) !== "") cache.storeFinal(jaNorm, en);
        return { en, source: en === "" ? "failed" : "mt" };
      }
    } catch (error) {
      emit({ kind: "error", detail: "Could not translate this caption." });
      console.warn("translate failed", error);
    }
    return { en: asEnText(""), source: "failed" };
  }
}

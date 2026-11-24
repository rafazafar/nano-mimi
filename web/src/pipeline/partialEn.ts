import { translationCacheKey, type TranslationCache } from "../core/cache";
import type { TranslationContext } from "../core/context";
import { applyGlossary, type Glossary } from "../core/glossary";
import { cpLength, isMostlyEnglish, normalizePunctuation, pyStrip } from "../core/text";
import { asEnText, asJaText, type EnText, type JaText } from "../core/types";
import type { GpuJob, GpuQueue } from "./gpuQueue";
import type { MtEngine, PipelineEvent } from "./types";

/** Clause-ending marks: a line holding one is worth previewing even when it is short. */
const CLAUSE_END = ["。", "？", "?", "！", "!"];
/** A preview this short counts as complete without a sentence mark, and seeds the cache. */
const COMPLETE_IF_SHORTER = 25;

export interface PartialEnDeps {
  readonly gpu: GpuQueue;
  readonly mt: MtEngine;
  readonly cache: TranslationCache;
  readonly context: TranslationContext;
  readonly glossary: () => Glossary;
  readonly emit: (event: PipelineEvent) => void;
  readonly enabled: boolean;
}

/**
 * Bounded, preemptible partial-JA to EN previews: English on screen before the final ASR text lands.
 * Port of `_PartialEnCoordinator`, with its safety rails:
 *
 * - at most one preview in flight, and none while the GPU is busy (the GPU queue skips it);
 * - a preview waits for a clause end or 20 characters, so its JA is close to the final's and the cache entry
 *   it seeds becomes the final's translation, and re-previews only after the JA grew by 12 characters;
 * - only a complete preview seeds the cache: a truncated one must not become the final translation;
 * - a monotonic version: once the final starts, a stale preview's tokens and result are dropped, and the
 *   running job is aborted so the final does not wait behind it.
 */
export class PartialEnCoordinator {
  static readonly MIN_JA_LEN = 8;
  static readonly PREFER_LEN = 20;
  static readonly REPREVIEW_GROWTH = 12;

  readonly #deps: PartialEnDeps;
  #version = 0;
  #finalStarted = false;
  #previewedLen = 0;
  #inFlight: Promise<void> | null = null;
  #job: GpuJob<unknown> | null = null;

  constructor(deps: PartialEnDeps) {
    this.#deps = deps;
  }

  get version(): number {
    return this.#version;
  }

  /** The preview now running, if any; resolves when it has finished or been dropped. */
  get inFlight(): Promise<void> | null {
    return this.#inFlight;
  }

  /** The final translation is starting: invalidate any preview and abort the one on the GPU. */
  cancel(): void {
    this.#version++;
    this.#finalStarted = true;
    this.#job?.cancel();
  }

  /** The final is fully handled; previews may run for the next utterance. */
  resetUtterance(): void {
    this.#finalStarted = false;
    this.#previewedLen = 0;
  }

  /** Offer the utterance's JA so far. Starts a preview when the cadence rules allow one. */
  schedule(ja: JaText): void {
    if (!this.#deps.enabled || this.#finalStarted || this.#inFlight !== null) return;
    const text = asJaText(pyStrip(ja));
    const length = cpLength(text);
    if (length < PartialEnCoordinator.MIN_JA_LEN || isMostlyEnglish(text)) return;
    const hasClauseEnd = CLAUSE_END.some((mark) => text.includes(mark));
    if (length < PartialEnCoordinator.PREFER_LEN && !hasClauseEnd) return;
    // The same text the final will translate, so a cached preview is the final's translation.
    const sent = applyGlossary(normalizePunctuation(text), this.#deps.glossary());
    if (translationCacheKey(sent) === "" || this.#deps.cache.has(sent)) return;
    if (this.#previewedLen > 0 && length < this.#previewedLen + PartialEnCoordinator.REPREVIEW_GROWTH) return;

    this.#version++;
    const version = this.#version;
    const run = this.#run(text, sent, version).finally(() => {
      if (this.#inFlight === run) this.#inFlight = null;
      this.#job = null;
    });
    this.#inFlight = run;
  }

  #live(version: number): boolean {
    return !this.#finalStarted && version === this.#version;
  }

  async #run(ja: JaText, sent: JaText, version: number): Promise<void> {
    if (!this.#live(version)) return;
    const { gpu, mt, context, emit } = this.#deps;
    const turns = context.pairs();
    let streamed = "";
    const job = gpu.submit("mt-preview", async (signal) => {
      const translation = mt.translate(sent, turns, {
        preview: true,
        onToken: (delta) => {
          if (!this.#live(version)) return;
          streamed += delta;
          const en = pyStrip(streamed);
          if (en !== "") emit({ kind: "partial_en", en: asEnText(en), version, complete: false });
        },
      });
      signal.addEventListener("abort", () => translation.cancel(), { once: true });
      return translation.outcome;
    });
    this.#job = job;
    let outcome;
    try {
      outcome = await job.outcome;
    } catch {
      return;
    }
    if (outcome.kind !== "done" || outcome.value.kind !== "done") return;
    const en: EnText = outcome.value.result.en;
    if (!this.#live(version) || en === "") return;

    this.#previewedLen = cpLength(ja);
    const trimmed = asEnText(pyStrip(en));
    const complete = this.#previewedLen <= COMPLETE_IF_SHORTER || ".!?".includes(trimmed.slice(-1));
    if (complete) this.#deps.cache.storePreview(sent, trimmed);
    emit({ kind: "partial_en", en, version, complete });
  }
}

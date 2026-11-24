import type { ContextTurn, EnText, JaText } from "../core/types";
import type { Translation } from "../mt/client";

declare const rowBrand: unique symbol;
/** A caption row's id. Allocated once per ASR final, including finals that merge into an earlier row. */
export type RowId = number & { readonly [rowBrand]: "RowId" };
export const asRowId = (n: number): RowId => n as RowId;

/** Time on the pipeline's own clock; `performance.now()` in the app, a counter in tests. */
export interface Clock {
  nowMs(): number;
}
export const performanceClock: Clock = { nowMs: () => performance.now() };

/**
 * One VAD utterance bound for ASR. Coalescing several keeps the oldest `enqueuedAtMs`,
 * the newest `audioEndS` and the longest `vadWaitS`, as `coalesce_asr_items` does.
 */
export interface AsrItem {
  readonly samples: Float32Array;
  readonly enqueuedAtMs: number;
  /** Audio-clock seconds consumed when the VAD emitted the utterance. */
  readonly audioEndS: number;
  /** Silence the VAD waited before it cut the utterance. */
  readonly vadWaitS: number;
}

/** What each stage of one caption cost. `perceivedS` is the eval's formula, `endToEndS` the wall clock. */
export interface Timing {
  readonly vadWaitS: number;
  /** In the ASR queue, plus any wait for the GPU, before the decode started. */
  readonly queueWaitS: number;
  readonly asrS: number;
  /** Submit to English back, GPU wait included. Zero for cache hits and passthrough. */
  readonly mtS: number;
  /** vadWaitS + queueWaitS + asrS + mtS: speech end to English on screen, as `make eval` defines it. */
  readonly perceivedS: number;
  /** Speech end to this event on the pipeline clock; adds the waits `perceivedS` leaves out. */
  readonly endToEndS: number;
}

/** Where a row's English came from. */
export type EnSource = "mt" | "cache" | "passthrough" | "failed";

export type Health = "ok" | "behind" | "overloaded";

/** What the pipeline tells the UI. Everything the screen shows derives from these, in order. */
export type PipelineEvent =
  /** The utterance in flight, as far as ASR has decoded it. Provisional. */
  | { readonly kind: "partial_ja"; readonly ja: JaText; readonly timelineS: number }
  /** A preview of the utterance in flight; `complete` previews also seed the cache. Provisional. */
  | { readonly kind: "partial_en"; readonly en: EnText; readonly version: number; readonly complete: boolean }
  /** ASR finished a line and translation of it began: a new row. */
  | { readonly kind: "translating"; readonly id: RowId; readonly timelineS: number; readonly ja: JaText }
  /** A later fragment continues row `targetId`; the joined line is being re-translated. */
  | { readonly kind: "revising"; readonly targetId: RowId; readonly ja: JaText }
  /** The joined line came back empty; the fragment becomes its own row (a `translating` follows). */
  | { readonly kind: "revision_failed"; readonly targetId: RowId }
  /** English streaming in for row `id` (the target row while it is being revised). Provisional. */
  | { readonly kind: "en_token"; readonly id: RowId; readonly delta: string }
  | {
      readonly kind: "final";
      readonly id: RowId;
      readonly timelineS: number;
      readonly durationS: number;
      readonly ja: JaText;
      readonly en: EnText;
      readonly source: EnSource;
      readonly timing: Timing;
    }
  /** Row `targetId` now spans its fragments: the merged JA and its new English, in place. */
  | {
      readonly kind: "revision";
      readonly targetId: RowId;
      readonly mergedIds: readonly RowId[];
      readonly timelineS: number;
      readonly durationS: number;
      readonly ja: JaText;
      readonly en: EnText;
      readonly source: EnSource;
      readonly timing: Timing;
    }
  /** How far captions trail the speaker, on the audio clock. */
  | { readonly kind: "backlog"; readonly backlogS: number; readonly health: Health }
  | { readonly kind: "error"; readonly detail: string };

export type EventListener = (event: PipelineEvent) => void;

/**
 * Speech recognition. `onSegment` receives each decoded segment as it appears, for engines that stream
 * (Whisper). Haas-ja decodes a clip in one shot, so it never calls it and the final is the only text.
 */
export interface AsrEngine {
  transcribe(samples: Float32Array, onSegment: (text: JaText) => void): Promise<JaText>;
}

export interface TranslateOptions {
  readonly preview: boolean;
  readonly onToken?: (delta: string) => void;
}

/** Translation. `MtClient` satisfies it; tests supply fakes. */
export interface MtEngine {
  translate(ja: JaText, context: readonly ContextTurn[], options: TranslateOptions): Translation;
}

export interface PipelineOptions {
  /**
   * `live` keeps at most `liveKeep` utterances waiting and merges the rest into one decode, so capture never
   * stalls and no speech is dropped. `lossless` (file replay) queues up to `capacity` and makes the feeder wait.
   */
  readonly queue: { readonly kind: "live"; readonly keep: number } | { readonly kind: "lossless"; readonly capacity: number };
  /** Seconds an item may wait before a dequeue merges it with whatever is queued behind it (live only). */
  readonly staleWaitS: number;
  readonly partialEn: boolean;
}

/** The Python defaults: `ASR_Q_LIVE_KEEP`, `ASR_Q_STALE_WAIT_S`, `ASR_Q_MAXSIZE`. */
export const LIVE_OPTIONS: PipelineOptions = { queue: { kind: "live", keep: 1 }, staleWaitS: 0.9, partialEn: true };
export const REPLAY_OPTIONS: PipelineOptions = { queue: { kind: "lossless", capacity: 4 }, staleWaitS: 0.9, partialEn: true };

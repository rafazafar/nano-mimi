import type { ContextTurn, EnText } from "../core/types";
import type { Manifest } from "../models/types";

/** Why a generation ran: the first pass, or one of `_do_translate_streaming`'s retries. */
export type AttemptReason = "first" | "no-context" | "grouped-digits";

/** One pass of CAT over a prompt. */
export interface Generation {
  readonly raw: string;
  readonly tokens: number;
  readonly ms: number;
  /** Time from the call to the first generated token; null when nothing was generated. */
  readonly ttftMs: number | null;
  /** (tokens - 1) / (last token time - first token time); null under 3 tokens. */
  readonly decodeTps: number | null;
}

export interface Attempt extends Generation {
  readonly reason: AttemptReason;
  readonly en: EnText;
}

export interface MtResult {
  readonly en: EnText;
  /** Raw output of the attempt that was kept. */
  readonly raw: string;
  readonly promptLeak: boolean;
  readonly japaneseStripped: boolean;
  /** The kept output still has numbers the Japanese does not contain. */
  readonly numbersMismatch: boolean;
  readonly attempts: readonly Attempt[];
  /** Index into `attempts` of the output that was kept. */
  readonly kept: number;
  readonly totalMs: number;
}

export interface AdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly description: string;
  readonly isFallbackAdapter: boolean;
  readonly shaderF16: boolean;
}

export interface LoadInfo {
  readonly tokenizerMs: number;
  readonly modelMs: number;
  readonly adapter: AdapterInfo | null;
  readonly runtime: string;
}

/** Page -> worker. */
export type MtRequest =
  | { readonly type: "init"; readonly manifest: Manifest; readonly modelId: string }
  | {
      readonly type: "translate";
      readonly id: number;
      readonly ja: string;
      readonly context: readonly ContextTurn[];
      readonly preview: boolean;
    }
  | { readonly type: "cancel"; readonly id: number };

/**
 * Worker -> page. Every translate request ends in exactly one of `done`,
 * `skipped` (a preview declined because CAT was busy), `cancelled` or `failed`.
 */
export type MtEvent =
  | { readonly type: "ready"; readonly load: LoadInfo }
  | { readonly type: "init-failed"; readonly message: string }
  | { readonly type: "token"; readonly id: number; readonly delta: string }
  | { readonly type: "done"; readonly id: number; readonly result: MtResult }
  | { readonly type: "skipped"; readonly id: number }
  | { readonly type: "cancelled"; readonly id: number }
  | { readonly type: "failed"; readonly id: number; readonly message: string };

export type MtOutcome =
  | { readonly kind: "done"; readonly result: MtResult }
  | { readonly kind: "skipped" }
  | { readonly kind: "cancelled" };

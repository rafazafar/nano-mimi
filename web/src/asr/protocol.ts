import type { PairId } from "../core/pair";
import type { Manifest } from "../models";
import type { Transcript } from "./haas";
import type { ModelBackend } from "./models";

/** What the worker reports about the device it runs on, for the bench and diagnostics. */
export interface AsrDevice {
  readonly backend: ModelBackend;
  readonly crossOriginIsolated: boolean;
  readonly hardwareConcurrency: number;
  /** Absent on the wasm backend. */
  readonly adapter?: {
    readonly vendor: string;
    readonly architecture: string;
    readonly isFallbackAdapter: boolean;
    readonly shaderF16: boolean;
    readonly features: readonly string[];
  };
}

export interface AsrInit {
  /** Must list `asrModels(pair, backend)`; they must already be downloaded. */
  readonly manifest: Manifest;
  /** Picks the recognizer for the pair's source language. */
  readonly pair: PairId;
  readonly backend: ModelBackend;
  /** wasm EP threads; needs crossOriginIsolated to exceed 1. */
  readonly threads: number;
}

export type AsrRequest =
  | ({ readonly type: "init" } & AsrInit)
  | { readonly type: "transcribe"; readonly id: number; readonly samples: Float32Array };

export type AsrResponse =
  | { readonly type: "ready"; readonly device: AsrDevice; readonly loadMs: number }
  | { readonly type: "transcript"; readonly id: number; readonly transcript: Transcript }
  /** `id` is null when init failed. */
  | { readonly type: "error"; readonly id: number | null; readonly message: string };

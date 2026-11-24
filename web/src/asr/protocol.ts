import type { Manifest } from "../models";
import type { Transcript } from "./haas";
import type { AsrBackend } from "./models";

/** What the worker reports about the device it runs on, for the bench and diagnostics. */
export interface AsrDevice {
  readonly backend: AsrBackend;
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
  /** Must list the backend's files (ASR_MODELS[backend]); they must already be downloaded. */
  readonly manifest: Manifest;
  readonly backend: AsrBackend;
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

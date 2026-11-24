import type { AsrBackend } from "../asr/models";
import type { GpuResult } from "../gpu";
import type { CapabilityIssue, StorageGrant } from "../models";
import type { FileRef, FileState, GpuRequirements, Manifest } from "../models/types";
import type { Clock, EnginePhase, Engines, Session, SessionOptions } from "../pipeline";
import type { DocumentPipApi } from "./pip";
import type { KeyValueStorage } from "./storage";

export interface ModelStoreLike {
  /** Reads every file's state from disk, reporting each through `onState`. No network. */
  refresh(): Promise<void>;
  allReady(): boolean;
  /** Resolves when every file is ready or has failed (reported through `onState`); throws `StorageQuotaError` before any fetch. */
  ensureAll(signal?: AbortSignal): Promise<void>;
  readonly storageGrant: StorageGrant;
}

export type ColorSchemeQuery = Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;

export interface AppEnv {
  /** `location.search`. */
  readonly search: string;
  readonly crossOriginIsolated: boolean;
  /** `(prefers-color-scheme: dark)`. */
  readonly systemDark: ColorSchemeQuery;
  /** Document Picture-in-Picture, or undefined where the browser has none. */
  readonly pip: DocumentPipApi | undefined;
  /** Whether the page is a secure context; the floating window needs one. */
  readonly secureContext: boolean;
}

export interface AppDeps {
  readonly probeGpu: () => Promise<GpuResult>;
  readonly checkCapabilities: (req: GpuRequirements) => Promise<readonly CapabilityIssue[]>;
  readonly createModelStore: (manifest: Manifest, onState: (ref: FileRef, state: FileState) => void) => ModelStoreLike;
  readonly loadEngines: (
    manifest: Manifest,
    backend: AsrBackend,
    onPhase: (phase: EnginePhase, state: "start" | "done") => void,
  ) => Promise<Engines>;
  readonly startSession: (options: SessionOptions) => Promise<Session>;
  readonly storage: KeyValueStorage;
  readonly clock: Clock;
  readonly env: AppEnv;
}

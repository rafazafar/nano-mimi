import type { PairId } from "../core/pair";
import type { AsrBackend } from "../asr/models";
import type { CapabilityIssue } from "../models";
import type { Manifest } from "../models/types";
import type { EnginePhase } from "../pipeline";
import type { Messages } from "./i18n";
import type { EndpointChoice } from "./setupModel";
import type { SourceChoice } from "./source";

export type PhaseStatus =
  | { readonly kind: "pending" }
  | { readonly kind: "loading" }
  | { readonly kind: "done"; readonly ms: number };

export type EnginePhases = Readonly<Record<EnginePhase, PhaseStatus>>;

export const ENGINE_PHASES: readonly EnginePhase[] = ["vad", "asr", "mt"];

export const pendingPhases: EnginePhases = { vad: { kind: "pending" }, asr: { kind: "pending" }, mt: { kind: "pending" } };

export interface Setup {
  /** The direction this setup downloads and loads models for. */
  readonly pair: PairId;
  readonly manifest: Manifest;
  readonly endpoint: EndpointChoice;
  readonly issues: readonly CapabilityIssue[];
  /** What the capability check recommends. */
  readonly autoBackend: AsrBackend;
  /** What will download: the recommendation, or the user's override. */
  readonly backend: AsrBackend;
  readonly totalBytes: number;
  /** Bytes not yet verified on disk; zero means every file is downloaded. */
  readonly missingBytes: number;
}

interface Loaded {
  readonly setup: Setup;
  readonly loadMs: number;
  readonly source: SourceChoice;
}

export type AppState =
  | { readonly kind: "booting" }
  | { readonly kind: "needs-setup"; readonly setup: Setup; readonly error: string | null }
  | { readonly kind: "downloading"; readonly setup: Setup }
  | { readonly kind: "loading-engines"; readonly setup: Setup; readonly phases: EnginePhases }
  | (Loaded & { readonly kind: "ready"; readonly sourceError: string | null })
  /** Start was pressed and the session has not come back: the permission prompt may still be open. */
  | (Loaded & { readonly kind: "starting" })
  | (Loaded & { readonly kind: "running" })
  | (Loaded & { readonly kind: "stopping" })
  /** Nothing can proceed without the user retrying; `retry` says which step to run again. */
  | {
      readonly kind: "error";
      readonly message: string;
      readonly retry: { readonly target: "boot" } | { readonly target: "load-engines"; readonly setup: Setup };
    };

export type AppAction =
  | { readonly type: "checked"; readonly setup: Setup }
  | { readonly type: "boot-failed"; readonly message: string }
  | { readonly type: "setup-updated"; readonly setup: Setup }
  | { readonly type: "download-started" }
  /** A download that was paused (`error` null) or failed; progress on disk is kept either way. */
  | { readonly type: "download-stopped"; readonly setup: Setup; readonly error: string | null }
  | { readonly type: "models-ready"; readonly setup: Setup }
  | { readonly type: "phase"; readonly phase: EnginePhase; readonly status: PhaseStatus }
  | { readonly type: "engines-ready"; readonly loadMs: number }
  | { readonly type: "engines-failed"; readonly message: string }
  | { readonly type: "retry" }
  /** The user picked the other direction. The app stored it and starts over, checking the new pair's models. */
  | { readonly type: "pair-switch-requested" }
  | { readonly type: "source-chosen"; readonly source: SourceChoice }
  | { readonly type: "source-rejected"; readonly message: string }
  | { readonly type: "start-requested" }
  | { readonly type: "session-started" }
  | { readonly type: "session-failed"; readonly message: string }
  | { readonly type: "stop-requested" }
  | { readonly type: "session-ended"; readonly error: string | null };

export type SetupStage = Extract<AppState, { kind: "booting" | "needs-setup" | "downloading" | "loading-engines" | "error" }>;

export const initialAppState: AppState = { kind: "booting" };

export const isFullyDownloaded = (setup: Setup): boolean => setup.missingBytes === 0 && setup.totalBytes > 0;

function loadingEngines(setup: Setup): AppState {
  return { kind: "loading-engines", setup, phases: pendingPhases };
}

export function canStart(state: AppState): boolean {
  return state.kind === "ready" && !(state.source.kind === "file" && state.source.pick === null);
}

/**
 * The transitions the lifecycle allows. An action that does not apply in the current state is dropped and
 * the same state object comes back, so a late event (a phase report after an error) cannot corrupt it.
 */
export function reduceApp(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "checked":
      return state.kind === "booting"
        ? isFullyDownloaded(action.setup)
          ? loadingEngines(action.setup)
          : { kind: "needs-setup", setup: action.setup, error: null }
        : state;
    case "boot-failed":
      return state.kind === "booting" ? { kind: "error", message: action.message, retry: { target: "boot" } } : state;
    case "setup-updated":
      return state.kind === "needs-setup" ? { kind: "needs-setup", setup: action.setup, error: null } : state;
    case "download-started":
      return state.kind === "needs-setup" ? { kind: "downloading", setup: state.setup } : state;
    case "download-stopped":
      return state.kind === "downloading" ? { kind: "needs-setup", setup: action.setup, error: action.error } : state;
    case "models-ready":
      return state.kind === "downloading" || state.kind === "needs-setup" ? loadingEngines(action.setup) : state;
    case "phase":
      return state.kind === "loading-engines" ? { ...state, phases: { ...state.phases, [action.phase]: action.status } } : state;
    case "engines-ready":
      return state.kind === "loading-engines"
        ? { kind: "ready", setup: state.setup, loadMs: action.loadMs, source: { kind: "mic" }, sourceError: null }
        : state;
    case "engines-failed":
      return state.kind === "loading-engines"
        ? { kind: "error", message: action.message, retry: { target: "load-engines", setup: state.setup } }
        : state;
    case "retry":
      if (state.kind !== "error") return state;
      return state.retry.target === "boot" ? initialAppState : loadingEngines(state.retry.setup);
    case "pair-switch-requested":
      return state.kind === "needs-setup" || state.kind === "ready" || state.kind === "error" ? initialAppState : state;
    case "source-chosen":
      return state.kind === "ready" ? { ...state, source: action.source, sourceError: null } : state;
    case "source-rejected":
      return state.kind === "ready" ? { ...state, sourceError: action.message } : state;
    case "start-requested":
      return canStart(state) && state.kind === "ready"
        ? { kind: "starting", setup: state.setup, loadMs: state.loadMs, source: state.source }
        : state;
    case "session-started":
      return state.kind === "starting" ? { ...state, kind: "running" } : state;
    case "session-failed":
      return state.kind === "starting"
        ? { kind: "ready", setup: state.setup, loadMs: state.loadMs, source: state.source, sourceError: action.message }
        : state;
    case "stop-requested":
      return state.kind === "running" ? { ...state, kind: "stopping" } : state;
    case "session-ended":
      return state.kind === "running" || state.kind === "stopping"
        ? { kind: "ready", setup: state.setup, loadMs: state.loadMs, source: state.source, sourceError: action.error }
        : state;
  }
}

export type StatusTone = "busy" | "idle" | "ok" | "live" | "error";

/** Where the direction can be changed: not while a download, a model load or a session holds the current pair. */
export const canSwitchPair = (state: AppState): boolean => state.kind === "needs-setup" || state.kind === "ready" || state.kind === "error";

/** The header chip: a short word for where the app is. `downloadFraction` is the live 0-1 progress while downloading. */
export function statusLabel(state: AppState, m: Messages, downloadFraction = 0): { readonly tone: StatusTone; readonly label: string } {
  switch (state.kind) {
    case "booting":
      return { tone: "busy", label: m.status.checking };
    case "needs-setup":
      return { tone: "idle", label: m.status.setupNeeded };
    case "downloading":
      return { tone: "busy", label: m.status.downloading(Math.floor(downloadFraction * 100)) };
    case "loading-engines":
      return { tone: "busy", label: m.status.loadingModels };
    case "ready":
      return { tone: "ok", label: m.status.ready };
    case "starting":
      return { tone: "busy", label: m.status.starting };
    case "running":
      return { tone: "live", label: m.status.live };
    case "stopping":
      return { tone: "busy", label: m.status.finishing };
    case "error":
      return { tone: "error", label: m.status.needsAttention };
  }
}

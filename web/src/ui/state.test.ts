import { describe, expect, it } from "vitest";
import { CAT_MODEL } from "../models/manifest";
import { ASR_MODELS } from "../asr/models";
import { totalBytes } from "../models/types";
import {
  canStart,
  initialAppState,
  isFullyDownloaded,
  pendingPhases,
  reduceApp,
  statusLabel,
  type AppAction,
  type AppState,
  type Setup,
} from "./state";
import type { SourceChoice } from "./source";

const manifest = { models: [...ASR_MODELS.webgpu, CAT_MODEL] };
const setup = (over: Partial<Setup> = {}): Setup => ({
  manifest,
  endpoint: { kind: "default" },
  issues: [],
  autoBackend: "webgpu",
  backend: "webgpu",
  totalBytes: totalBytes(manifest),
  missingBytes: totalBytes(manifest),
  ...over,
});
const downloaded = setup({ missingBytes: 0 });

const run = (actions: readonly AppAction[], from: AppState = initialAppState): AppState => actions.reduce(reduceApp, from);

const wavPick = { kind: "file", pick: { name: "a.wav", bytes: new Uint8Array(4), sampleRate: 16000 } } as const satisfies SourceChoice;

const readyState = (): AppState =>
  run([
    { type: "checked", setup: downloaded },
    { type: "engines-ready", loadMs: 9_000 },
  ]);

describe("app lifecycle", () => {
  it("goes straight to loading when every file is already downloaded", () => {
    const state = run([{ type: "checked", setup: downloaded }]);
    expect(state).toEqual({ kind: "loading-engines", setup: downloaded, phases: pendingPhases });
  });

  it("asks for setup when anything is missing", () => {
    const state = run([{ type: "checked", setup: setup() }]);
    expect(state).toMatchObject({ kind: "needs-setup", error: null });
  });

  it("walks setup, download, engine load and ready in order", () => {
    const state = run([
      { type: "checked", setup: setup() },
      { type: "download-started" },
      { type: "models-ready", setup: downloaded },
      { type: "phase", phase: "vad", status: { kind: "loading" } },
      { type: "phase", phase: "vad", status: { kind: "done", ms: 300 } },
      { type: "phase", phase: "asr", status: { kind: "loading" } },
      { type: "phase", phase: "asr", status: { kind: "done", ms: 4000 } },
      { type: "phase", phase: "mt", status: { kind: "done", ms: 6000 } },
      { type: "engines-ready", loadMs: 10_300 },
    ]);
    expect(state).toMatchObject({ kind: "ready", loadMs: 10_300, source: { kind: "mic" }, sourceError: null });
  });

  it("records phase progress on the loading state", () => {
    const state = run([
      { type: "checked", setup: downloaded },
      { type: "phase", phase: "vad", status: { kind: "done", ms: 300 } },
      { type: "phase", phase: "asr", status: { kind: "loading" } },
    ]);
    expect(state).toMatchObject({ phases: { vad: { kind: "done", ms: 300 }, asr: { kind: "loading" }, mt: { kind: "pending" } } });
  });

  it("returns a paused or failed download to setup with its message", () => {
    const failed = run([{ type: "checked", setup: setup() }, { type: "download-started" }, { type: "download-stopped", setup: setup(), error: "Not enough browser storage" }]);
    expect(failed).toMatchObject({ kind: "needs-setup", error: "Not enough browser storage" });
    const paused = run([{ type: "download-started" }, { type: "download-stopped", setup: setup(), error: null }], failed);
    expect(paused).toMatchObject({ kind: "needs-setup", error: null });
  });

  it("lets setup load a backend that is already on disk without downloading", () => {
    const state = run([{ type: "checked", setup: setup() }, { type: "setup-updated", setup: downloaded }, { type: "models-ready", setup: downloaded }]);
    expect(state.kind).toBe("loading-engines");
  });

  it("offers a retry that reruns the step that failed", () => {
    const failedLoad = run([{ type: "checked", setup: downloaded }, { type: "engines-failed", message: "GPU device lost" }]);
    expect(failedLoad).toMatchObject({ kind: "error", message: "GPU device lost", retry: { target: "load-engines" } });
    expect(reduceApp(failedLoad, { type: "retry" })).toEqual({ kind: "loading-engines", setup: downloaded, phases: pendingPhases });

    const failedBoot = run([{ type: "boot-failed", message: "OPFS unavailable" }]);
    expect(failedBoot).toMatchObject({ kind: "error", retry: { target: "boot" } });
    expect(reduceApp(failedBoot, { type: "retry" })).toEqual(initialAppState);
  });
});

describe("capture lifecycle", () => {
  it("starts, runs, stops and returns to ready with the source kept", () => {
    const state = run(
      [{ type: "start-requested" }, { type: "session-started" }, { type: "stop-requested" }, { type: "session-ended", error: null }],
      readyState(),
    );
    expect(state).toMatchObject({ kind: "ready", source: { kind: "mic" }, sourceError: null });
  });

  it("keeps the permission failure inline and recoverable", () => {
    const failed = run([{ type: "start-requested" }, { type: "session-failed", message: "Permission denied" }], readyState());
    expect(failed).toMatchObject({ kind: "ready", sourceError: "Permission denied" });
    expect(canStart(failed)).toBe(true);
    expect(run([{ type: "start-requested" }], failed).kind).toBe("starting");
  });

  it("clears the inline error when the source changes", () => {
    const failed = run([{ type: "source-rejected", message: "not a WAV" }], readyState());
    expect(failed).toMatchObject({ sourceError: "not a WAV" });
    expect(run([{ type: "source-chosen", source: { kind: "tab" } }], failed)).toMatchObject({ source: { kind: "tab" }, sourceError: null });
  });

  it("does not start a file source that has no file", () => {
    const state = run([{ type: "source-chosen", source: { kind: "file", pick: null } }], readyState());
    expect(canStart(state)).toBe(false);
    expect(run([{ type: "start-requested" }], state)).toBe(state);
    const picked = run([{ type: "source-chosen", source: wavPick }, { type: "start-requested" }], state);
    expect(picked.kind).toBe("starting");
  });

  it("returns to ready when a replayed file ends on its own", () => {
    const state = run([{ type: "start-requested" }, { type: "session-started" }, { type: "session-ended", error: null }], readyState());
    expect(state.kind).toBe("ready");
  });

  it("reports a session that died, back in ready", () => {
    const state = run([{ type: "start-requested" }, { type: "session-started" }, { type: "session-ended", error: "Capture stopped" }], readyState());
    expect(state).toMatchObject({ kind: "ready", sourceError: "Capture stopped" });
  });
});

describe("illegal transitions", () => {
  const cases: [string, AppState, AppAction][] = [
    ["start before the engines load", run([{ type: "checked", setup: setup() }]), { type: "start-requested" }],
    ["a second start while starting", run([{ type: "start-requested" }], readyState()), { type: "start-requested" }],
    ["stop when nothing runs", readyState(), { type: "stop-requested" }],
    ["a phase report after the load failed", run([{ type: "checked", setup: downloaded }, { type: "engines-failed", message: "x" }]), { type: "phase", phase: "mt", status: { kind: "loading" } }],
    ["engines-ready when not loading", readyState(), { type: "engines-ready", loadMs: 1 }],
    ["a source change while running", run([{ type: "start-requested" }, { type: "session-started" }], readyState()), { type: "source-chosen", source: { kind: "tab" } }],
    ["a download while ready", readyState(), { type: "download-started" }],
    ["session-ended while ready", readyState(), { type: "session-ended", error: null }],
    ["retry without an error", readyState(), { type: "retry" }],
  ];
  it.each(cases)("ignores %s", (_name, state, action) => {
    expect(reduceApp(state, action)).toBe(state);
  });
});

describe("derived", () => {
  it("knows when nothing is left to download", () => {
    expect(isFullyDownloaded(downloaded)).toBe(true);
    expect(isFullyDownloaded(setup())).toBe(false);
    expect(isFullyDownloaded(setup({ totalBytes: 0, missingBytes: 0 }))).toBe(false);
  });

  it("labels each state for the header", () => {
    expect(statusLabel(initialAppState)).toEqual({ tone: "busy", label: "Checking this browser" });
    expect(statusLabel(run([{ type: "checked", setup: setup() }, { type: "download-started" }]), 0.416)).toEqual({ tone: "busy", label: "Downloading 41%" });
    expect(statusLabel(readyState())).toEqual({ tone: "ok", label: "Ready" });
    expect(statusLabel(run([{ type: "start-requested" }, { type: "session-started" }], readyState())).tone).toBe("live");
    expect(statusLabel(run([{ type: "boot-failed", message: "x" }])).tone).toBe("error");
  });
});

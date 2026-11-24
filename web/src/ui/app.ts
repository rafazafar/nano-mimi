import { asrBackend, type AsrBackend } from "../asr/models";
import { aggregateRequirements, type StorageGrant } from "../models";
import type { FileRef, FileState } from "../models/types";
import type { CaptionState, Engines, PipelineEvent, Session } from "../pipeline";
import { emptyCaptions, reduceCaptions } from "../pipeline/rows";
import type { GpuResult } from "../gpu";
import type { AppDeps, ModelStoreLike } from "./deps";
import { DiagnosticsView } from "./diagnostics";
import { append, h, setAttr, setHidden } from "./dom";
import { describeStartError, errorMessage } from "./errors";
import { FloatingCaptions } from "./floating";
import { GlossaryEditor } from "./glossaryEditor";
import { GlossaryStore } from "./glossaryStore";
import { HeaderView } from "./header";
import { LiveView, isLiveState } from "./live";
import { detectPip } from "./pip";
import { createFrameScheduler } from "./schedule";
import { SetupView, isSetupState } from "./setup";
import {
  BACKEND_KEY,
  buildManifest,
  downloadProgress,
  fileKey,
  parseBackend,
  parseEndpointParam,
  type DownloadProgress,
  type EndpointChoice,
} from "./setupModel";
import { readWavPick, toSourceSpec, type PickedFile, type SourceKind } from "./source";
import { canStart, initialAppState, reduceApp, statusLabel, type AppAction, type AppState, type Setup } from "./state";
import { clearItem, readItem, writeItem } from "./storage";
import { applyTheme, effectiveTheme, loadTheme, saveTheme, toggleTheme, type ThemeChoice } from "./theme";

export interface AppHandle {
  readonly state: () => AppState;
  readonly captions: () => CaptionState;
  dispose(): void;
}

const TICK_MS = 500;

export function mountApp(root: HTMLElement, deps: AppDeps): AppHandle {
  return new App(root, deps);
}

class App implements AppHandle {
  private appState: AppState = initialAppState;
  private captionState: CaptionState = emptyCaptions;
  private fileStates = new Map<string, FileState>();
  private store: ModelStoreLike | null = null;
  private engines: Engines | null = null;
  private session: Session | null = null;
  private download: AbortController | null = null;
  private gpu: GpuResult | null = null;
  private storageGrant: StorageGrant | null = null;
  private loadStartedMs = 0;
  private inspectSeq = 0;
  private lastPick: PickedFile | null = null;
  private theme: ThemeChoice;
  private disposed = false;
  private dragDepth = 0;
  private readonly glossary: GlossaryStore;
  private readonly shell: HTMLElement;
  private readonly header: HeaderView;
  private readonly setup: SetupView;
  private readonly live: LiveView;
  private readonly diagnostics = new DiagnosticsView();
  private readonly floating: FloatingCaptions;
  private readonly frame = createFrameScheduler(window, () => this.paint());
  private readonly ticker: number;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly deps: AppDeps,
  ) {
    this.glossary = new GlossaryStore(deps.storage);
    this.theme = loadTheme(deps.storage);
    applyTheme(document.documentElement, this.theme);

    this.header = new HeaderView(() => this.onToggleTheme());
    this.setup = new SetupView({
      onChooseBackend: (backend) => void this.chooseBackend(backend),
      onDownload: () => void this.startDownload(),
      onPause: () => this.download?.abort(),
      onRetry: () => this.retry(),
    });
    this.live = new LiveView(
      {
        onChooseSource: (kind) => this.chooseSource(kind),
        onPickFile: (file) => void this.pickFile(file),
        onStart: () => void this.start(),
        onStop: () => void this.stop(),
        onToggleFloating: () => this.toggleFloating(),
      },
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    this.floating = new FloatingCaptions({
      support: detectPip({ documentPictureInPicture: deps.env.pip, isSecureContext: deps.env.secureContext }),
      opener: document,
      captions: () => this.captionState,
      changed: () => this.frame.schedule(),
    });

    const stage = h("main", { class: "stage", id: "main" }, this.setup.el, this.live.el);
    const side = h("aside", { class: "side", "aria-label": "Glossary and diagnostics" }, new GlossaryEditor(this.glossary).el, this.diagnostics.el);
    this.shell = h("div", { class: "shell", "data-role": "shell" }, this.header.el, h("div", { class: "layout" }, stage, side));
    append(root, [this.shell]);

    this.listen(deps.env.systemDark, "change", () => this.frame.schedule());
    this.listenDrop();
    this.ticker = window.setInterval(() => this.tick(), TICK_MS);
    this.paint();
    void this.boot();
  }

  state = (): AppState => this.appState;
  captions = (): CaptionState => this.captionState;

  dispose(): void {
    this.disposed = true;
    window.clearInterval(this.ticker);
    this.frame.cancel();
    this.download?.abort();
    this.floating.close();
    for (const undo of this.cleanup) undo();
    const session = this.session;
    this.session = null;
    void session?.stop().catch(() => undefined);
    this.engines?.dispose();
    this.engines = null;
    this.root.replaceChildren();
  }

  private dispatch(action: AppAction): void {
    const next = reduceApp(this.appState, action);
    if (next === this.appState) return;
    this.appState = next;
    this.frame.schedule();
  }

  private listen(target: Pick<EventTarget, "addEventListener" | "removeEventListener">, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.cleanup.push(() => target.removeEventListener(type, handler));
  }

  private tick(): void {
    const kind = this.appState.kind;
    if (kind === "loading-engines" || kind === "running" || kind === "stopping") this.frame.schedule();
  }

  private async boot(): Promise<void> {
    const { deps } = this;
    void deps.probeGpu().then(
      (gpu) => {
        this.gpu = gpu;
        this.frame.schedule();
      },
      (error: unknown) => {
        this.gpu = { kind: "unavailable", reason: errorMessage(error) };
        this.frame.schedule();
      },
    );
    try {
      const endpoint = parseEndpointParam(deps.env.search);
      const issues = await deps.checkCapabilities(aggregateRequirements(buildManifest("webgpu", endpoint)));
      const auto = asrBackend(issues);
      const stored = parseBackend(readItem(deps.storage, BACKEND_KEY));
      const setup = await this.inspect(stored ?? auto, auto, endpoint, issues);
      if (setup === null || this.disposed) return;
      this.dispatch({ type: "checked", setup });
      if (this.appState.kind === "loading-engines") void this.loadEngines();
    } catch (error) {
      this.dispatch({ type: "boot-failed", message: `Could not check this browser: ${errorMessage(error)}` });
    }
  }

  private async inspect(backend: AsrBackend, auto: AsrBackend, endpoint: EndpointChoice, issues: Setup["issues"]): Promise<Setup | null> {
    const token = ++this.inspectSeq;
    const manifest = buildManifest(backend, endpoint);
    this.fileStates = new Map();
    const store = this.deps.createModelStore(manifest, (ref: FileRef, state: FileState) => {
      if (token !== this.inspectSeq) return;
      this.fileStates.set(fileKey(ref), state);
      this.frame.schedule();
    });
    await store.refresh();
    if (token !== this.inspectSeq) return null;
    this.store = store;
    const progress = downloadProgress(manifest, this.fileStates);
    return {
      manifest,
      endpoint,
      issues,
      autoBackend: auto,
      backend,
      totalBytes: progress.totalBytes,
      missingBytes: progress.totalBytes - progress.doneBytes,
    };
  }

  private async chooseBackend(backend: AsrBackend): Promise<void> {
    const state = this.appState;
    if (state.kind !== "needs-setup" || backend === state.setup.backend) return;
    if (backend === state.setup.autoBackend) clearItem(this.deps.storage, BACKEND_KEY);
    else writeItem(this.deps.storage, BACKEND_KEY, backend);
    try {
      const { endpoint, issues, autoBackend } = state.setup;
      const setup = await this.inspect(backend, autoBackend, endpoint, issues);
      if (setup !== null) this.dispatch({ type: "setup-updated", setup });
    } catch (error) {
      this.dispatch({ type: "download-started" });
      this.dispatch({ type: "download-stopped", setup: state.setup, error: `Could not read model storage: ${errorMessage(error)}` });
    }
  }

  private async startDownload(): Promise<void> {
    const state = this.appState;
    const store = this.store;
    if (state.kind !== "needs-setup" || store === null) return;
    const { setup } = state;
    if (setup.missingBytes === 0) {
      this.dispatch({ type: "models-ready", setup });
      void this.loadEngines();
      return;
    }
    this.dispatch({ type: "download-started" });
    const abort = new AbortController();
    this.download = abort;
    try {
      await store.ensureAll(abort.signal);
      this.storageGrant = store.storageGrant;
      const progress = downloadProgress(setup.manifest, this.fileStates);
      if (!store.allReady()) {
        const reason = progress.failures.length > 0 ? progress.failures.join("; ") : "Some files did not finish downloading.";
        this.dispatch({ type: "download-stopped", setup: { ...setup, missingBytes: progress.totalBytes - progress.doneBytes }, error: reason });
        return;
      }
      this.dispatch({ type: "models-ready", setup: { ...setup, missingBytes: 0 } });
      await this.loadEngines();
    } catch (error) {
      const progress = downloadProgress(setup.manifest, this.fileStates);
      const paused = abort.signal.aborted;
      this.dispatch({
        type: "download-stopped",
        setup: { ...setup, missingBytes: progress.totalBytes - progress.doneBytes },
        error: paused ? null : errorMessage(error),
      });
    } finally {
      if (this.download === abort) this.download = null;
    }
  }

  private async loadEngines(): Promise<void> {
    const state = this.appState;
    if (state.kind !== "loading-engines") return;
    const { setup } = state;
    const { clock } = this.deps;
    this.loadStartedMs = clock.nowMs();
    const started = new Map<string, number>();
    try {
      const engines = await this.deps.loadEngines(setup.manifest, setup.backend, (phase, edge) => {
        const now = clock.nowMs();
        if (edge === "start") {
          started.set(phase, now);
          this.dispatch({ type: "phase", phase, status: { kind: "loading" } });
        } else {
          this.dispatch({ type: "phase", phase, status: { kind: "done", ms: now - (started.get(phase) ?? now) } });
        }
      });
      if (this.disposed) {
        engines.dispose();
        return;
      }
      this.engines = engines;
      this.storageGrant = this.store?.storageGrant ?? this.storageGrant;
      this.dispatch({ type: "engines-ready", loadMs: engines.info.totalLoadMs });
    } catch (error) {
      this.dispatch({ type: "engines-failed", message: `The models did not load: ${errorMessage(error)}` });
    }
  }

  private retry(): void {
    this.dispatch({ type: "retry" });
    if (this.appState.kind === "booting") void this.boot();
    else if (this.appState.kind === "loading-engines") void this.loadEngines();
  }

  private chooseSource(kind: SourceKind): void {
    this.dispatch({ type: "source-chosen", source: kind === "file" ? { kind, pick: this.lastPick } : { kind } });
  }

  private async pickFile(file: File): Promise<void> {
    const result = await readWavPick(file);
    if (this.appState.kind !== "ready") return;
    if (!result.ok) {
      this.dispatch({ type: "source-rejected", message: result.message });
      return;
    }
    this.lastPick = result.pick;
    this.dispatch({ type: "source-chosen", source: { kind: "file", pick: result.pick } });
  }

  private async start(): Promise<void> {
    const state = this.appState;
    const engines = this.engines;
    if (state.kind !== "ready" || !canStart(state) || engines === null) return;
    const source = toSourceSpec(state.source);
    if (source === null) return;
    this.dispatch({ type: "start-requested" });
    this.captionState = emptyCaptions;
    this.floating.refresh();
    try {
      const session = await this.deps.startSession({
        engines,
        source,
        glossary: () => this.glossary.glossary(),
        onEvent: (event) => this.onEvent(event),
      });
      if (this.disposed || this.appState.kind !== "starting") {
        await session.stop().catch(() => undefined);
        return;
      }
      this.session = session;
      this.dispatch({ type: "session-started" });
      session.ended.then(
        () => this.endSession(session, null),
        (error: unknown) => this.endSession(session, errorMessage(error)),
      );
    } catch (error) {
      this.dispatch({ type: "session-failed", message: describeStartError(error, state.source.kind) });
    }
  }

  private async stop(): Promise<void> {
    const session = this.session;
    if (this.appState.kind !== "running" || session === null) return;
    this.dispatch({ type: "stop-requested" });
    try {
      await session.stop();
      this.endSession(session, null);
    } catch (error) {
      this.endSession(session, errorMessage(error));
    }
  }

  private endSession(session: Session, error: string | null): void {
    if (this.session !== session) return;
    this.session = null;
    this.onEvent({ kind: "backlog", backlogS: 0, health: "ok" });
    this.dispatch({ type: "session-ended", error });
  }

  private onEvent(event: PipelineEvent): void {
    this.captionState = reduceCaptions(this.captionState, event);
    this.frame.schedule();
    this.floating.refresh();
  }

  private toggleFloating(): void {
    if (this.floating.state.kind === "open") this.floating.close();
    else void this.floating.open();
  }

  private onToggleTheme(): void {
    this.theme = toggleTheme(this.theme, this.deps.env.systemDark.matches);
    saveTheme(this.deps.storage, this.theme);
    applyTheme(document.documentElement, this.theme);
    this.floating.setTheme(this.theme === "system" ? undefined : this.theme);
    this.frame.schedule();
  }

  private listenDrop(): void {
    const hasFiles = (e: DragEvent): boolean => e.dataTransfer?.types.includes("Files") === true;
    const canDrop = (): boolean => this.appState.kind === "ready";
    this.listen(document, "dragenter", (e) => {
      if (!hasFiles(e as DragEvent)) return;
      e.preventDefault();
      this.dragDepth++;
      if (canDrop()) this.live.setDropTarget(true);
    });
    this.listen(document, "dragover", (e) => {
      if (!hasFiles(e as DragEvent)) return;
      e.preventDefault();
      const transfer = (e as DragEvent).dataTransfer;
      if (transfer !== null) transfer.dropEffect = canDrop() ? "copy" : "none";
    });
    this.listen(document, "dragleave", (e) => {
      if (!hasFiles(e as DragEvent)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.live.setDropTarget(false);
    });
    this.listen(document, "drop", (e) => {
      if (!hasFiles(e as DragEvent)) return;
      e.preventDefault();
      this.dragDepth = 0;
      this.live.setDropTarget(false);
      const file = (e as DragEvent).dataTransfer?.files[0];
      if (canDrop() && file !== undefined) void this.pickFile(file);
    });
  }

  private paint(): void {
    if (this.disposed) return;
    const state = this.appState;
    const captions = this.captionState;
    const setupState = isSetupState(state);
    setAttr(this.shell, "data-app-state", state.kind);
    setHidden(this.setup.el, !setupState);
    setHidden(this.live.el, setupState);

    const setup = setupOf(state);
    const progress = setup === null ? EMPTY_PROGRESS : downloadProgress(setup.manifest, this.fileStates);
    this.header.update({
      status: statusLabel(state, progress.fraction),
      health: captions.health,
      backlogS: captions.backlogS,
      theme: effectiveTheme(this.theme, this.deps.env.systemDark.matches),
    });

    if (setupState) {
      this.setup.update({
        state,
        progress,
        gpuLabel: this.gpu?.kind === "ok" ? `${this.gpu.report.vendor} ${this.gpu.report.architecture}`.trim() : null,
        crossOriginIsolated: this.deps.env.crossOriginIsolated,
        loadElapsedMs: state.kind === "loading-engines" ? this.deps.clock.nowMs() - this.loadStartedMs : 0,
      });
    }
    if (isLiveState(state)) {
      this.live.update({ state, captions, floating: this.floating.state, elapsedS: this.session?.audioSeconds() ?? 0 });
    }

    const systemTheme = effectiveTheme("system", this.deps.env.systemDark.matches);
    this.diagnostics.update({
      gpu: this.gpu,
      crossOriginIsolated: this.deps.env.crossOriginIsolated,
      setup,
      engines: this.engines?.info ?? null,
      storageGrant: this.storageGrant,
      theme: this.theme === "system" ? `system (${systemTheme})` : this.theme,
      rows: captions.rows,
    });
  }
}

const EMPTY_PROGRESS: DownloadProgress = { totalBytes: 0, doneBytes: 0, fraction: 0, models: [], failures: [] };

function setupOf(state: AppState): Setup | null {
  if ("setup" in state) return state.setup;
  if (state.kind === "error" && state.retry.target === "load-engines") return state.retry.setup;
  return null;
}

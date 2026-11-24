import type { AsrBackend } from "../asr/models";
import { formatBytes, totalBytes, type FileState } from "../models/types";
import type { EnginePhase } from "../pipeline";
import { h, setAttr, setHidden, setText } from "./dom";
import { formatMs } from "./format";
import { icon } from "./icons";
import { ENGINE_PHASES, type AppState, type EnginePhases, type Setup, type SetupStage } from "./state";
import { buildManifest, describeEndpoint, setupActionLabel, type DownloadProgress, type FileProgress } from "./setupModel";

export interface SetupCallbacks {
  onChooseBackend(backend: AsrBackend): void;
  onDownload(): void;
  onPause(): void;
  onRetry(): void;
}

export interface SetupModel {
  readonly state: SetupStage;
  readonly progress: DownloadProgress;
  /** One line about the adapter the probe found, or null while unknown. */
  readonly gpuLabel: string | null;
  readonly crossOriginIsolated: boolean;
  /** Milliseconds since the engines began loading, ticking while they do. */
  readonly loadElapsedMs: number;
}

const BACKEND_COPY: Readonly<Record<AsrBackend, { readonly title: string; readonly detail: string }>> = {
  webgpu: { title: "GPU (WebGPU)", detail: "Fastest. Speech recognition runs on your graphics card." },
  wasm: { title: "CPU (WebAssembly)", detail: "For machines without a usable GPU. Slower, and translation still needs WebGPU." },
};

const PHASE_LABEL: Readonly<Record<EnginePhase, string>> = {
  vad: "Voice detection",
  asr: "Speech recognition",
  mt: "Translation",
};

export const isSetupState = (state: AppState): state is SetupStage =>
  state.kind === "booting" || state.kind === "needs-setup" || state.kind === "downloading" || state.kind === "loading-engines" || state.kind === "error";

function describeFile(state: FileState, size: number): string {
  switch (state.kind) {
    case "missing":
      return formatBytes(size);
    case "partial":
      return `${formatBytes(state.bytes)} of ${formatBytes(size)}`;
    case "verifying":
      return "Verifying";
    case "ready":
      return `${formatBytes(size)} verified`;
    case "failed":
      return "Failed";
  }
}

type Meter = ReturnType<typeof meter>;

interface FileRow {
  readonly el: HTMLElement;
  readonly meter: Meter;
  readonly detail: HTMLElement;
}

interface PhaseRow {
  readonly el: HTMLElement;
  readonly time: HTMLElement;
}

function meter(label: string): { readonly el: HTMLElement; readonly fill: HTMLElement } {
  const fill = h("span", { class: "meter-fill" });
  const el = h("div", { class: "meter", role: "progressbar", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, fill);
  return { el, fill };
}

function setMeter(m: Meter, fraction: number): void {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  setAttr(m.el, "aria-valuenow", String(pct));
  const scale = `scaleX(${Math.min(1, Math.max(0, fraction)).toFixed(4)})`;
  if (m.fill.style.transform !== scale) m.fill.style.transform = scale;
}

export class SetupView {
  readonly el: HTMLElement;
  private readonly lede: HTMLElement;
  private readonly capability: HTMLElement;
  private readonly checks: HTMLElement;
  private readonly capabilityNote: HTMLElement;
  private readonly backendBlock: HTMLElement;
  private readonly backendOptions: HTMLElement;
  private readonly backendNote: HTMLElement;
  private readonly modelsBlock: HTMLElement;
  private readonly endpointNote: HTMLElement;
  private readonly overallText: HTMLElement;
  private readonly overall: Meter;
  private readonly fileList: HTMLElement;
  private readonly setupError: HTMLElement;
  private readonly primary: HTMLButtonElement;
  private readonly primaryLabel: HTMLElement;
  private readonly pause: HTMLButtonElement;
  private readonly enginesBlock: HTMLElement;
  private readonly phaseList: HTMLElement;
  private readonly elapsed: HTMLElement;
  private readonly errorBlock: HTMLElement;
  private readonly errorText: HTMLElement;
  private readonly bootingBlock: HTMLElement;
  private fileRows = new Map<string, FileRow>();
  private readonly phaseRows = new Map<EnginePhase, PhaseRow>();
  private checksKey = "";
  private builtFor: unknown = null;
  private optionsBuiltFor: unknown = null;

  constructor(private readonly callbacks: SetupCallbacks) {
    this.lede = h("p", { class: "lede" });
    this.bootingBlock = h("div", { class: "setup-block busy-line", "data-role": "booting" }, h("span", { class: "spinner", "aria-hidden": "true" }), "Checking this browser");

    this.checks = h("ul", { class: "checks", "data-role": "checks" });
    this.capabilityNote = h("p", { class: "note" });
    this.capability = h("section", { class: "setup-block", "data-role": "capability", "aria-labelledby": "setup-h-browser" }, h("h2", { id: "setup-h-browser" }, "This browser"), this.checks, this.capabilityNote);

    this.backendOptions = h("div", { class: "options", role: "radiogroup", "aria-labelledby": "setup-h-speech" });
    this.backendNote = h("p", { class: "note" });
    this.backendBlock = h("section", { class: "setup-block", "data-role": "backend" }, h("h2", { id: "setup-h-speech" }, "Speech recognition"), this.backendOptions, this.backendNote);

    this.endpointNote = h("p", { class: "note endpoint-note", "data-role": "endpoint" });
    this.overallText = h("p", { class: "overall-text", "data-role": "overall" });
    this.overall = meter("Download progress");
    this.fileList = h("div", { class: "files", "data-role": "files" });
    this.setupError = h("p", { class: "notice notice-error", role: "alert", "data-role": "setup-error", hidden: true });
    this.primaryLabel = h("span", {});
    this.primary = h("button", { class: "btn btn-primary", type: "button", "data-role": "download", onclick: () => this.callbacks.onDownload() }, icon("download"), this.primaryLabel);
    this.pause = h("button", { class: "btn", type: "button", "data-role": "pause", hidden: true, onclick: () => this.callbacks.onPause() }, icon("pause"), "Pause");
    this.modelsBlock = h(
      "section",
      { class: "setup-block", "data-role": "models" },
      h("h2", { id: "setup-h-models" }, "Models"),
      this.endpointNote,
      h("div", { class: "overall" }, this.overallText, this.overall.el),
      this.fileList,
      this.setupError,
      h("div", { class: "actions" }, this.primary, this.pause),
    );

    this.phaseList = h("ol", { class: "phases", "data-role": "phases" });
    for (const phase of ENGINE_PHASES) {
      const time = h("span", { class: "phase-time" });
      const el = h(
        "li",
        { class: "phase", "data-phase": phase },
        h("span", { class: "phase-mark", "aria-hidden": "true" }, icon("check", "icon phase-icon"), h("span", { class: "spinner" }), h("span", { class: "pending-dot" })),
        h("span", { class: "phase-name" }, PHASE_LABEL[phase]),
        time,
      );
      this.phaseRows.set(phase, { el, time });
      this.phaseList.append(el);
    }
    this.elapsed = h("p", { class: "note", "data-role": "load-elapsed" });
    this.enginesBlock = h("section", { class: "setup-block", "data-role": "engines" }, h("h2", {}, "Loading models"), this.phaseList, this.elapsed);

    this.errorText = h("p", { class: "notice notice-error", role: "alert", "data-role": "fatal-error" });
    this.errorBlock = h(
      "section",
      { class: "setup-block", "data-role": "fatal" },
      h("h2", {}, "Something stopped"),
      this.errorText,
      h("div", { class: "actions" }, h("button", { class: "btn btn-primary", type: "button", "data-role": "retry", onclick: () => this.callbacks.onRetry() }, icon("retry"), "Try again")),
    );

    this.el = h("section", { class: "setup", "data-role": "setup" }, h("header", { class: "setup-head" }, h("h1", {}, "Set up live captions"), this.lede), this.bootingBlock, this.capability, this.backendBlock, this.modelsBlock, this.enginesBlock, this.errorBlock);
  }

  update(model: SetupModel): void {
    const { state } = model;
    setAttr(this.el, "data-phase", state.kind);
    const showChoices = state.kind === "needs-setup" || state.kind === "downloading";
    setHidden(this.bootingBlock, state.kind !== "booting");
    setHidden(this.capability, !(showChoices || state.kind === "error"));
    setHidden(this.backendBlock, !showChoices);
    setHidden(this.modelsBlock, !showChoices);
    setHidden(this.enginesBlock, state.kind !== "loading-engines");
    setHidden(this.errorBlock, state.kind !== "error");

    if (state.kind === "booting") {
      setText(this.lede, "");
      return;
    }
    if (state.kind === "error") {
      setText(this.lede, "Nothing was lost. Fix the cause below and try again.");
      setText(this.errorText, state.message);
      if (state.retry.target === "load-engines") this.paintCapability(state.retry.setup, model);
      return;
    }
    if (state.kind === "loading-engines") {
      setText(this.lede, "The models are on this device. Loading them into memory needs no network.");
      this.paintPhases(state.phases);
      setText(this.elapsed, `Loading for ${formatMs(model.loadElapsedMs)}.`);
      return;
    }
    setText(this.lede, `Captions run entirely in this browser. The speech and translation models (${formatBytes(state.setup.totalBytes)}) download once and stay on this device.`);
    this.paintCapability(state.setup, model);
    this.paintBackend(state, model);
    this.paintModels(state, model);
  }

  private paintCapability(setup: Setup, model: SetupModel): void {
    const lines: [boolean, string, string | undefined][] =
      setup.issues.length === 0
        ? [[true, model.gpuLabel === null ? "WebGPU is available, with everything the models need." : `WebGPU is available (${model.gpuLabel}), with everything the models need.`, undefined]]
        : setup.issues.map((issue) => [false, issue.message, issue.code]);
    const key = JSON.stringify(lines);
    if (key !== this.checksKey) {
      this.checksKey = key;
      this.checks.replaceChildren(...lines.map(([ok, text, code]) => this.check(ok, text, code)));
    }
    setText(
      this.capabilityNote,
      setup.issues.length === 0 ? "" : "Translation runs on WebGPU in every setup, so captions may not load here even with CPU speech recognition.",
    );
    setHidden(this.capabilityNote, setup.issues.length === 0);
  }

  private check(ok: boolean, text: string, code?: string): HTMLElement {
    return h("li", { class: "check", "data-ok": String(ok), "data-code": code }, icon(ok ? "check" : "alert", "icon check-icon"), h("span", {}, text));
  }

  private paintBackend(state: Extract<AppState, { kind: "needs-setup" | "downloading" }>, model: SetupModel): void {
    const { setup } = state;
    const locked = state.kind === "downloading";
    if (this.optionsBuiltFor !== setup.manifest) {
      this.optionsBuiltFor = setup.manifest;
      const options = (["webgpu", "wasm"] as const).map((backend) => {
        const size = totalBytes(buildManifest(backend, setup.endpoint, setup.pair));
        const input = h("input", { type: "radio", name: "asr-backend", value: backend, "data-backend": backend, onchange: () => this.callbacks.onChooseBackend(backend) });
        return h(
          "label",
          { class: "option", "data-backend": backend },
          input,
          h(
            "span",
            { class: "option-body" },
            h("span", { class: "option-title" }, BACKEND_COPY[backend].title, backend === setup.autoBackend ? h("span", { class: "tag tag-ok" }, "Recommended here") : null),
            h("span", { class: "option-detail" }, BACKEND_COPY[backend].detail),
            h("span", { class: "option-size" }, `${formatBytes(size)} to download in total`),
          ),
        );
      });
      this.backendOptions.replaceChildren(...options);
    }
    for (const input of this.backendOptions.querySelectorAll<HTMLInputElement>("input")) {
      input.checked = input.value === setup.backend;
      input.disabled = locked;
    }
    const lines: string[] = [];
    if (setup.backend !== setup.autoBackend) lines.push(`You overrode the recommendation (${BACKEND_COPY[setup.autoBackend].title}).`);
    if (setup.backend === "wasm" && !model.crossOriginIsolated) {
      lines.push("This page is not cross-origin isolated, so the CPU path runs on one thread and will be much slower.");
    }
    if (setup.backend === "webgpu" && setup.issues.length > 0) lines.push("The browser check above found problems for the GPU path.");
    setText(this.backendNote, lines.join(" "));
    setHidden(this.backendNote, lines.length === 0);
  }

  private paintModels(state: Extract<AppState, { kind: "needs-setup" | "downloading" }>, model: SetupModel): void {
    const { setup } = state;
    const { progress } = model;
    this.buildFiles(setup, progress);
    for (const m of progress.models) {
      for (const f of m.files) this.paintFile(m.id, f);
    }
    const downloading = state.kind === "downloading";
    setText(this.endpointNote, describeEndpoint(setup.endpoint));
    setAttr(this.endpointNote, "data-kind", setup.endpoint.kind);
    setText(
      this.overallText,
      progress.totalBytes === 0 ? "No models are configured." : `${formatBytes(progress.doneBytes)} of ${formatBytes(progress.totalBytes)}`,
    );
    setAttr(this.overallText, "data-state", downloading ? "downloading" : setup.missingBytes === 0 ? "ready" : "needs-download");
    setMeter(this.overall, progress.fraction);
    const error = state.kind === "needs-setup" ? state.error : null;
    setText(this.setupError, error ?? "");
    setHidden(this.setupError, error === null);
    setText(this.primaryLabel, downloading ? "Downloading" : state.kind === "needs-setup" && error !== null ? `Try again, ${formatBytes(setup.missingBytes)}${setup.missingBytes < setup.totalBytes ? " left" : ""}` : setupActionLabel(setup));
    this.primary.disabled = downloading || progress.totalBytes === 0;
    setAttr(this.primary, "aria-busy", downloading ? "true" : null);
    setHidden(this.pause, !downloading);
  }

  private buildFiles(setup: Setup, progress: DownloadProgress): void {
    if (this.builtFor === setup.manifest) return;
    this.builtFor = setup.manifest;
    this.fileRows = new Map();
    const groups = progress.models.map((m) => {
      const rows = m.files.map((f) => {
        const bar = meter(f.path);
        const detail = h("span", { class: "file-detail" });
        const el = h("li", { class: "file", "data-path": f.path }, h("span", { class: "file-name" }, f.path), bar.el, detail);
        this.fileRows.set(`${m.id}\u0000${f.path}`, { el, meter: bar, detail });
        return el;
      });
      return h("div", { class: "file-group" }, h("h3", {}, m.label, h("span", { class: "group-size" }, formatBytes(m.size))), h("ul", {}, ...rows));
    });
    this.fileList.replaceChildren(...groups);
  }

  private paintFile(modelId: string, f: FileProgress): void {
    const row = this.fileRows.get(`${modelId}\u0000${f.path}`);
    if (row === undefined) return;
    setAttr(row.el, "data-state", f.state.kind);
    setMeter(row.meter, f.size === 0 ? 1 : f.doneBytes / f.size);
    setText(row.detail, describeFile(f.state, f.size));
  }

  private paintPhases(phases: EnginePhases): void {
    for (const phase of ENGINE_PHASES) {
      const row = this.phaseRows.get(phase);
      const status = phases[phase];
      if (row === undefined) continue;
      setAttr(row.el, "data-status", status.kind);
      setText(row.time, status.kind === "done" ? formatMs(status.ms) : status.kind === "loading" ? "Loading" : "Waiting");
    }
  }
}

import type { GpuReport, GpuResult } from "../gpu";
import type { StorageGrant } from "../models";
import type { CaptionRow, EngineInfo } from "../pipeline";
import { h, setAttr, setText } from "./dom";
import { formatMs, formatSeconds } from "./format";
import { perceivedStats } from "./stats";
import type { Setup } from "./state";

export interface DiagnosticsModel {
  readonly gpu: GpuResult | null;
  readonly crossOriginIsolated: boolean;
  readonly setup: Setup | null;
  readonly engines: EngineInfo | null;
  readonly storageGrant: StorageGrant | null;
  readonly theme: string;
  readonly rows: readonly CaptionRow[];
}

export function gpuRows(report: GpuReport): readonly (readonly [string, string])[] {
  return [
    ["vendor", report.vendor],
    ["architecture", report.architecture],
    ["device", report.device],
    ["description", report.description],
    ["fallback adapter", String(report.isFallbackAdapter)],
    ["shader-f16", String(report.shaderF16)],
    ["features", report.features.join(", ")],
    ...Object.entries(report.limits).map(([k, v]): readonly [string, string] => [k, String(v)]),
  ];
}

export function gpuStatus(result: GpuResult | null): { readonly state: "pending" | "ready" | "fallback" | "unavailable"; readonly text: string } {
  if (result === null) return { state: "pending", text: "Checking WebGPU..." };
  if (result.kind === "unavailable") return { state: "unavailable", text: `WebGPU unavailable: ${result.reason}` };
  const { report } = result;
  return { state: report.isFallbackAdapter ? "fallback" : "ready", text: `WebGPU adapter: ${report.vendor} ${report.architecture}`.trim() };
}

class KeyValues {
  readonly el: HTMLElement;
  private readonly values = new Map<string, HTMLElement>();

  constructor(fields: readonly (readonly [string, string])[]) {
    this.el = h("dl", { class: "kv" });
    for (const [field, label] of fields) {
      const dd = h("dd", { "data-field": field }, "-");
      this.values.set(field, dd);
      this.el.append(h("dt", {}, label), dd);
    }
  }

  set(field: string, value: string): void {
    const dd = this.values.get(field);
    if (dd !== undefined) setText(dd, value);
  }
}

export class DiagnosticsView {
  readonly el: HTMLDetailsElement;
  private readonly status: HTMLElement;
  private readonly gpuList: HTMLElement;
  private readonly runtime = new KeyValues([
    ["crossOriginIsolated", "Cross-origin isolated"],
    ["asr-backend", "Speech backend"],
    ["asr-device", "Speech device"],
    ["mt-runtime", "Translation runtime"],
    ["mt-adapter", "Translation adapter"],
    ["storage", "Model storage"],
    ["endpoint", "Download endpoint"],
    ["theme", "Theme"],
  ]);
  private readonly loads = new KeyValues([
    ["load-vad", "Voice detection"],
    ["load-asr", "Speech recognition"],
    ["load-mt", "Translation"],
    ["load-total", "Total"],
  ]);
  private readonly latency = new KeyValues([
    ["perceived-count", "Lines measured"],
    ["perceived-p50", "Perceived p50"],
    ["perceived-p95", "Perceived p95"],
  ]);
  private gpuShown: GpuResult | null = null;
  private statsRows: readonly CaptionRow[] | null = null;
  private rows: readonly CaptionRow[] = [];

  constructor() {
    this.status = h("p", { id: "gpu-status", "data-state": "pending" }, "Checking WebGPU...");
    this.gpuList = h("dl", { id: "gpu-details", class: "kv", hidden: true });
    this.el = h(
      "details",
      { class: "diagnostics", "data-role": "diagnostics", ontoggle: () => this.onToggle() },
      h("summary", {}, h("span", {}, "Diagnostics")),
      h(
        "div",
        { class: "diag-body" },
        h("section", {}, h("h3", {}, "WebGPU"), this.status, this.gpuList),
        h("section", {}, h("h3", {}, "Runtime"), this.runtime.el),
        h("section", {}, h("h3", {}, "Engine load times"), this.loads.el),
        h("section", {}, h("h3", {}, "Latency, this session"), this.latency.el),
      ),
    );
  }

  private onToggle(): void {
    this.statsRows = null;
    this.paintLatency(this.rows);
  }

  update(model: DiagnosticsModel): void {
    this.rows = model.rows;
    this.paintGpu(model.gpu);
    this.paintRuntime(model);
    this.paintLoads(model.engines);
    this.paintLatency(model.rows);
  }

  private paintGpu(gpu: GpuResult | null): void {
    if (gpu === this.gpuShown) return;
    this.gpuShown = gpu;
    const status = gpuStatus(gpu);
    setAttr(this.status, "data-state", status.state);
    setText(this.status, status.text);
    if (gpu?.kind !== "ok") return;
    this.gpuList.replaceChildren(
      ...gpuRows(gpu.report).flatMap(([label, value]) => [h("dt", {}, label), h("dd", { "data-field": label }, value)]),
    );
    this.gpuList.hidden = false;
  }

  private paintRuntime(model: DiagnosticsModel): void {
    const { engines, setup } = model;
    this.runtime.set("crossOriginIsolated", String(model.crossOriginIsolated));
    this.runtime.set("asr-backend", setup === null ? "-" : `${setup.backend}${setup.backend === setup.autoBackend ? "" : " (chosen)"}`);
    this.runtime.set("asr-device", engines === null ? "-" : describeAsrDevice(engines));
    this.runtime.set("mt-runtime", engines === null ? "-" : engines.mt.runtime);
    this.runtime.set("mt-adapter", engines?.mt.adapter == null ? "-" : `${engines.mt.adapter.vendor} ${engines.mt.adapter.architecture}`.trim());
    this.runtime.set("storage", model.storageGrant ?? "-");
    this.runtime.set("endpoint", setup === null ? "-" : (setup.manifest.endpoint ?? "default"));
    this.runtime.set("theme", model.theme);
  }

  private paintLoads(engines: EngineInfo | null): void {
    this.loads.set("load-vad", engines === null ? "-" : formatMs(engines.vadLoadMs));
    this.loads.set("load-asr", engines === null ? "-" : formatMs(engines.asrLoadMs));
    this.loads.set("load-mt", engines === null ? "-" : formatMs(engines.mtLoadMs));
    this.loads.set("load-total", engines === null ? "-" : formatMs(engines.totalLoadMs));
  }

  private paintLatency(rows: readonly CaptionRow[]): void {
    if (!this.el.open || rows === this.statsRows) return;
    this.statsRows = rows;
    const stats = perceivedStats(rows);
    this.latency.set("perceived-count", stats === null ? "0" : String(stats.count));
    this.latency.set("perceived-p50", stats === null ? "-" : formatSeconds(stats.p50));
    this.latency.set("perceived-p95", stats === null ? "-" : formatSeconds(stats.p95));
  }
}

function describeAsrDevice(info: EngineInfo): string {
  const device = info.asr;
  if (device.adapter === undefined) return `wasm, ${device.hardwareConcurrency} cores${device.crossOriginIsolated ? "" : ", single thread"}`;
  return `${device.adapter.vendor} ${device.adapter.architecture}${device.adapter.isFallbackAdapter ? " (fallback)" : ""}`.trim();
}

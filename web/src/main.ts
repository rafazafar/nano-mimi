import { probeGpu, type GpuReport } from "./gpu";

function requireElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} missing from index.html`);
  return el;
}

function renderDetails(target: HTMLElement, report: GpuReport): void {
  const rows: [string, string][] = [
    ["vendor", report.vendor],
    ["architecture", report.architecture],
    ["device", report.device],
    ["description", report.description],
    ["fallback adapter", String(report.isFallbackAdapter)],
    ["shader-f16", String(report.shaderF16)],
    ["features", report.features.join(", ")],
    ...Object.entries(report.limits).map(([k, v]): [string, string] => [k, String(v)]),
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dd.dataset["field"] = label;
    target.append(dt, dd);
  }
  target.hidden = false;
}

async function main(): Promise<void> {
  const status = requireElement("gpu-status");
  const details = requireElement("gpu-details");
  const result = await probeGpu(navigator.gpu);
  if (result.kind === "unavailable") {
    status.dataset["state"] = "unavailable";
    status.textContent = `WebGPU unavailable: ${result.reason}`;
    return;
  }
  const { report } = result;
  status.dataset["state"] = report.isFallbackAdapter ? "fallback" : "ready";
  status.textContent = `WebGPU adapter: ${report.vendor} ${report.architecture}`.trim();
  renderDetails(details, report);
}

void main();

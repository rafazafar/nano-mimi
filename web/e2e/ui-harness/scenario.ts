import type { GpuResult } from "../../src/gpu";
import type { CapabilityIssue } from "../../src/models";

export type StoredFiles = "none" | "partial" | "all";
export type GpuScenario = "ok" | "no-f16" | "none";
/** `real` hands the page the browser's own Document Picture-in-Picture, for the headed run. */
export type PipScenario = "fake" | "real" | "none";
export type EnginesScenario = "manual" | "auto";

/** What the harness page stages, read from its query string so a test picks the scene with its URL. */
export interface Scenario {
  readonly stored: StoredFiles;
  readonly gpu: GpuScenario;
  readonly pip: PipScenario;
  readonly engines: EnginesScenario;
}

function pick<T extends string>(params: URLSearchParams, key: string, allowed: readonly T[], fallback: T): T {
  const value = params.get(key);
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

export function parseScenario(search: string): Scenario {
  const params = new URLSearchParams(search);
  return {
    stored: pick(params, "stored", ["none", "partial", "all"], "none"),
    gpu: pick(params, "gpu", ["ok", "no-f16", "none"], "ok"),
    pip: pick(params, "pip", ["fake", "real", "none"], "fake"),
    engines: pick(params, "engines", ["manual", "auto"], "manual"),
  };
}

/** A fixed adapter so screenshots do not change between machines. */
export function fakeGpu(scenario: GpuScenario): GpuResult {
  if (scenario === "none") return { kind: "unavailable", reason: "navigator.gpu is not defined" };
  return {
    kind: "ok",
    report: {
      vendor: "apple",
      architecture: "metal-3",
      device: "",
      description: "Apple M3 Pro",
      isFallbackAdapter: false,
      shaderF16: scenario === "ok",
      features: scenario === "ok" ? ["shader-f16", "timestamp-query"] : ["timestamp-query"],
      limits: { maxBufferSize: 4294967296, maxStorageBufferBindingSize: 2147483644 },
    },
  };
}

export function fakeIssues(scenario: GpuScenario): readonly CapabilityIssue[] {
  switch (scenario) {
    case "ok":
      return [];
    case "no-f16":
      return [{ code: "no-shader-f16", message: "The GPU does not support shader-f16, which the models need." }];
    case "none":
      return [{ code: "no-webgpu", message: "WebGPU is not available in this browser (navigator.gpu is undefined)." }];
  }
}

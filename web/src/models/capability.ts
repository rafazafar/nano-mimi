import type { GpuRequirements, Manifest } from "./types";

export type CapabilityCode =
  | "no-webgpu"
  | "no-adapter"
  | "fallback-adapter"
  | "no-shader-f16"
  | "max-buffer-size"
  | "max-storage-binding-size";

export interface CapabilityIssue {
  readonly code: CapabilityCode;
  readonly message: string;
}

export interface GpuLike {
  requestAdapter(): Promise<{
    readonly features: ReadonlySet<string>;
    readonly limits: { readonly maxBufferSize: number; readonly maxStorageBufferBindingSize: number };
    readonly info: { readonly isFallbackAdapter: boolean };
  } | null>;
}

/** The strictest requirement across every model in the manifest. */
export function aggregateRequirements(manifest: Manifest): GpuRequirements {
  let out: GpuRequirements = { shaderF16: false, minMaxBufferSize: 0, minMaxStorageBufferBindingSize: 0 };
  for (const m of manifest.models) {
    if (m.gpu === undefined) continue;
    out = {
      shaderF16: out.shaderF16 || m.gpu.shaderF16,
      minMaxBufferSize: Math.max(out.minMaxBufferSize, m.gpu.minMaxBufferSize),
      minMaxStorageBufferBindingSize: Math.max(out.minMaxStorageBufferBindingSize, m.gpu.minMaxStorageBufferBindingSize),
    };
  }
  return out;
}

/** Empty result means the machine can run the manifest's models. Adapter limits are what the GPU offers; runtimes must still request them in `requestDevice`. */
export async function checkCapabilities(gpu: GpuLike | undefined, req: GpuRequirements): Promise<readonly CapabilityIssue[]> {
  if (gpu === undefined) return [{ code: "no-webgpu", message: "WebGPU is not available in this browser (navigator.gpu is undefined)." }];
  const adapter = await gpu.requestAdapter();
  if (adapter === null) return [{ code: "no-adapter", message: "No WebGPU adapter was found for this device." }];
  const issues: CapabilityIssue[] = [];
  if (adapter.info.isFallbackAdapter) {
    issues.push({ code: "fallback-adapter", message: "Only a software (fallback) WebGPU adapter is available; it is too slow for these models." });
  }
  if (req.shaderF16 && !adapter.features.has("shader-f16")) {
    issues.push({ code: "no-shader-f16", message: "The GPU does not support shader-f16, which the models need." });
  }
  if (adapter.limits.maxBufferSize < req.minMaxBufferSize) {
    issues.push({
      code: "max-buffer-size",
      message: `maxBufferSize is ${adapter.limits.maxBufferSize} but the models need ${req.minMaxBufferSize}.`,
    });
  }
  if (adapter.limits.maxStorageBufferBindingSize < req.minMaxStorageBufferBindingSize) {
    issues.push({
      code: "max-storage-binding-size",
      message: `maxStorageBufferBindingSize is ${adapter.limits.maxStorageBufferBindingSize} but the models need ${req.minMaxStorageBufferBindingSize}.`,
    });
  }
  return issues;
}

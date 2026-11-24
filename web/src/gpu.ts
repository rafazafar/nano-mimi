export interface GpuReport {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly isFallbackAdapter: boolean;
  readonly shaderF16: boolean;
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}

export type GpuResult =
  | { readonly kind: "ok"; readonly report: GpuReport }
  | { readonly kind: "unavailable"; readonly reason: string };

const KEY_LIMITS = [
  "maxBufferSize",
  "maxStorageBufferBindingSize",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxStorageBuffersPerShaderStage",
] as const;

export async function probeGpu(gpu: GPU | undefined): Promise<GpuResult> {
  if (gpu === undefined) {
    return { kind: "unavailable", reason: "navigator.gpu is not defined" };
  }
  const adapter = await gpu.requestAdapter();
  if (adapter === null) {
    return { kind: "unavailable", reason: "requestAdapter() returned null" };
  }
  const features = [...adapter.features].sort();
  const limits: Record<string, number> = {};
  for (const name of KEY_LIMITS) {
    limits[name] = adapter.limits[name];
  }
  const { info } = adapter;
  return {
    kind: "ok",
    report: {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      isFallbackAdapter: info.isFallbackAdapter,
      shaderF16: features.includes("shader-f16"),
      features,
      limits,
    },
  };
}

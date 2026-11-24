export interface GpuRequirements {
  readonly shaderF16: boolean;
  readonly minMaxBufferSize: number;
  readonly minMaxStorageBufferBindingSize: number;
}

export interface FileSpec {
  readonly path: string;
  /** Absolute URL override. Defaults to `<endpoint>/<repo>/resolve/<revision>/<path>`. */
  readonly url?: string;
  readonly size: number;
  /** Lowercase hex SHA-256 of the whole file. */
  readonly sha256: string;
}

export interface ModelSpec {
  /** Stable, filesystem-safe id (`[A-Za-z0-9._-]+`). */
  readonly id: string;
  readonly label: string;
  readonly repo: string;
  readonly revision: string;
  readonly files: readonly FileSpec[];
  readonly gpu?: GpuRequirements;
}

export interface Manifest {
  /** Base download endpoint, no trailing slash. Defaults to huggingface.co. */
  readonly endpoint?: string;
  /** Mirror tried when the endpoint fails (network error, HTTP error, or a dropped connection). */
  readonly fallbackEndpoint?: string;
  readonly models: readonly ModelSpec[];
}

export const DEFAULT_ENDPOINT = "https://huggingface.co";

/** `partial.bytes` counts bytes received so far (on disk plus the in-flight chunk). */
export type FileState =
  | { readonly kind: "missing" }
  | { readonly kind: "partial"; readonly bytes: number }
  | { readonly kind: "verifying" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly reason: string };

export interface FileRef {
  readonly modelId: string;
  readonly path: string;
}

export class StorageQuotaError extends Error {
  constructor(
    readonly neededBytes: number,
    readonly availableBytes: number,
  ) {
    super(
      `Not enough browser storage: models need ${formatBytes(neededBytes)} more but only ` +
        `${formatBytes(availableBytes)} is available. Free disk space or clear site data, then retry.`,
    );
    this.name = "StorageQuotaError";
  }
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

export function fileUrl(manifest: Manifest, model: ModelSpec, file: FileSpec, base = manifest.endpoint ?? DEFAULT_ENDPOINT): string {
  if (file.url !== undefined) return file.url;
  const endpoint = base.replace(/\/+$/, "");
  const path = file.path.split("/").map(encodeURIComponent).join("/");
  return `${endpoint}/${model.repo}/resolve/${encodeURIComponent(model.revision)}/${path}`;
}

export function totalBytes(manifest: Manifest): number {
  return manifest.models.reduce((n, m) => n + m.files.reduce((k, f) => k + f.size, 0), 0);
}

/** Parse untrusted JSON into a Manifest, throwing on the first problem. */
export function parseManifest(input: unknown): Manifest {
  const obj = asRecord(input, "manifest");
  const endpoint = obj["endpoint"];
  if (endpoint !== undefined && typeof endpoint !== "string") throw new Error("manifest.endpoint must be a string");
  const fallbackEndpoint = obj["fallbackEndpoint"];
  if (fallbackEndpoint !== undefined && typeof fallbackEndpoint !== "string") throw new Error("manifest.fallbackEndpoint must be a string");
  const modelsRaw = obj["models"];
  if (!Array.isArray(modelsRaw)) throw new Error("manifest.models must be an array");
  const models = modelsRaw.map((m, i) => parseModel(m, `models[${i}]`));
  return {
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(fallbackEndpoint === undefined ? {} : { fallbackEndpoint }),
    models,
  };
}

function asRecord(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${where} must be an object`);
  return v as Record<string, unknown>;
}

function str(o: Record<string, unknown>, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== "string" || v === "") throw new Error(`${where}.${k} must be a non-empty string`);
  return v;
}

function num(o: Record<string, unknown>, k: string, where: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${where}.${k} must be a non-negative number`);
  return v;
}

function parseModel(raw: unknown, where: string): ModelSpec {
  const o = asRecord(raw, where);
  const id = str(o, "id", where);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`${where}.id must match [A-Za-z0-9._-]+`);
  const filesRaw = o["files"];
  if (!Array.isArray(filesRaw) || filesRaw.length === 0) throw new Error(`${where}.files must be a non-empty array`);
  const files = filesRaw.map((f, i): FileSpec => {
    const w = `${where}.files[${i}]`;
    const fo = asRecord(f, w);
    const sha256 = str(fo, "sha256", w).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${w}.sha256 must be 64 hex chars`);
    const base = { path: str(fo, "path", w), size: num(fo, "size", w), sha256 };
    return typeof fo["url"] === "string" ? { ...base, url: fo["url"] } : base;
  });
  const base = { id, label: str(o, "label", where), repo: str(o, "repo", where), revision: str(o, "revision", where), files };
  const g = o["gpu"];
  if (g === undefined) return base;
  const go = asRecord(g, `${where}.gpu`);
  return {
    ...base,
    gpu: {
      shaderF16: go["shaderF16"] === true,
      minMaxBufferSize: num(go, "minMaxBufferSize", `${where}.gpu`),
      minMaxStorageBufferBindingSize: num(go, "minMaxStorageBufferBindingSize", `${where}.gpu`),
    },
  };
}

import { ASR_MODELS, type AsrBackend } from "../asr/models";
import { CAT_MODEL } from "../models/manifest";
import { DEFAULT_ENDPOINT, formatBytes, totalBytes, type FileRef, type FileState, type Manifest } from "../models/types";

export type EndpointChoice =
  | { readonly kind: "default" }
  | { readonly kind: "custom"; readonly url: string }
  | { readonly kind: "invalid"; readonly raw: string };

/**
 * `?endpoint=<url>` points downloads at a mirror or a local server. The URL is untrusted input: it must be
 * http(s) without credentials. Query and fragment are dropped and a trailing slash is trimmed, because the
 * model store joins `/<repo>/resolve/...` onto it.
 */
export function parseEndpointParam(search: string): EndpointChoice {
  const raw = new URLSearchParams(search).get("endpoint");
  if (raw === null || raw.trim() === "") return { kind: "default" };
  try {
    const url = new URL(raw.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") return { kind: "invalid", raw };
    return { kind: "custom", url: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
  } catch {
    return { kind: "invalid", raw };
  }
}

const RAW_ENDPOINT_SHOWN = 80;

export function describeEndpoint(choice: EndpointChoice): string {
  const fallback = new URL(DEFAULT_ENDPOINT).host;
  switch (choice.kind) {
    case "default":
      return `Downloads come from ${fallback}.`;
    case "custom":
      return `Downloads come from ${choice.url}, as the endpoint in the address asks.`;
    case "invalid": {
      const raw = choice.raw.length > RAW_ENDPOINT_SHOWN ? `${choice.raw.slice(0, RAW_ENDPOINT_SHOWN)}...` : choice.raw;
      return `The endpoint in the address (${raw}) is not a plain http or https address, so it was ignored. Downloads come from ${fallback}.`;
    }
  }
}

/** The MimiVox proxy (workers/hf-proxy): serves pinned files from its R2 copy, else streams them from the Hub. */
export const MIRROR_ENDPOINT = "https://hf.zafar.jp";

export function buildManifest(backend: AsrBackend, endpoint: EndpointChoice): Manifest {
  const models = [...ASR_MODELS[backend], CAT_MODEL];
  return endpoint.kind === "custom" ? { endpoint: endpoint.url, models } : { fallbackEndpoint: MIRROR_ENDPOINT, models };
}

export const BACKEND_KEY = "mimivox.asr-backend.v1";

export function parseBackend(raw: string | null): AsrBackend | null {
  return raw === "webgpu" || raw === "wasm" ? raw : null;
}

export const fileKey = (ref: FileRef): string => `${ref.modelId}\u0000${ref.path}`;

export function setupActionLabel(setup: { readonly totalBytes: number; readonly missingBytes: number }): string {
  if (setup.missingBytes <= 0) return "Load models";
  if (setup.missingBytes < setup.totalBytes) return `Resume download, ${formatBytes(setup.missingBytes)} left`;
  return `Download ${formatBytes(setup.totalBytes)}`;
}

export interface FileProgress {
  readonly path: string;
  readonly size: number;
  readonly state: FileState;
  readonly doneBytes: number;
}

export interface ModelProgress {
  readonly id: string;
  readonly label: string;
  readonly size: number;
  readonly doneBytes: number;
  readonly files: readonly FileProgress[];
}

export interface DownloadProgress {
  readonly totalBytes: number;
  readonly doneBytes: number;
  /** 0 to 1; a verified file counts in full, a partial one by the bytes received. */
  readonly fraction: number;
  readonly models: readonly ModelProgress[];
  /** Reasons for files that failed (checksum, HTTP), in manifest order. */
  readonly failures: readonly string[];
}

function doneBytesOf(state: FileState, size: number): number {
  switch (state.kind) {
    case "ready":
    case "verifying":
      return size;
    case "partial":
      return Math.min(state.bytes, size);
    case "missing":
    case "failed":
      return 0;
  }
}

export function downloadProgress(manifest: Manifest, states: ReadonlyMap<string, FileState>): DownloadProgress {
  const failures: string[] = [];
  const models = manifest.models.map((model): ModelProgress => {
    const files = model.files.map((file): FileProgress => {
      const state = states.get(fileKey({ modelId: model.id, path: file.path })) ?? { kind: "missing" };
      if (state.kind === "failed") failures.push(`${file.path}: ${state.reason}`);
      return { path: file.path, size: file.size, state, doneBytes: doneBytesOf(state, file.size) };
    });
    return {
      id: model.id,
      label: model.label,
      size: files.reduce((n, f) => n + f.size, 0),
      doneBytes: files.reduce((n, f) => n + f.doneBytes, 0),
      files,
    };
  });
  const total = totalBytes(manifest);
  const done = models.reduce((n, m) => n + m.doneBytes, 0);
  return { totalBytes: total, doneBytes: done, fraction: total === 0 ? 0 : done / total, models, failures };
}

import type { BlobStore, StoredEntry } from "./blob-store";
import { Sha256 } from "./sha256";
import {
  fileUrl,
  StorageQuotaError,
  type FileRef,
  type FileSpec,
  type FileState,
  type Manifest,
  type ModelSpec,
} from "./types";

export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const MARKER = "verified";

export interface StorageLike {
  persist?(): Promise<boolean>;
  estimate?(): Promise<{ quota?: number; usage?: number }>;
}

export interface ModelStoreOptions {
  readonly manifest: Manifest;
  readonly store: BlobStore;
  readonly fetch?: typeof fetch;
  readonly storage?: StorageLike;
  readonly onState?: (ref: FileRef, state: FileState) => void;
  /** Bytes per on-disk chunk; also the granularity of resume. */
  readonly chunkBytes?: number;
  /** Extra attempts after a checksum mismatch (each starts from zero bytes). */
  readonly mismatchRetries?: number;
}

export type StorageGrant = "persistent" | "best-effort";

class CorruptDownload extends Error {}

function chunkName(i: number): string {
  return String(i).padStart(6, "0");
}

function keyOf(ref: FileRef): string {
  return `${ref.modelId}\u0000${ref.path}`;
}

/**
 * Downloads manifest files into a BlobStore (OPFS in the browser) and hands them back.
 *
 * Each file is a directory of fixed-size chunks plus a `verified` marker holding the
 * manifest sha256 and size. Chunks are written atomically, so the bytes on disk are always
 * a valid prefix and a killed tab resumes at the next chunk boundary with an HTTP Range.
 * Re-running converges: verified files are never fetched, partial ones continue.
 */
export class ModelStore {
  private readonly manifest: Manifest;
  private readonly store: BlobStore;
  private readonly fetchFn: typeof fetch;
  private readonly storage: StorageLike | undefined;
  private readonly chunk: number;
  private readonly retries: number;
  private readonly states = new Map<string, FileState>();
  private grant: StorageGrant = "best-effort";
  /** Set once the primary endpoint has failed; later downloads go straight to the fallback. */
  private onFallback = false;

  constructor(private readonly opts: ModelStoreOptions) {
    this.manifest = opts.manifest;
    this.store = opts.store;
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.storage = opts.storage;
    this.chunk = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.retries = opts.mismatchRetries ?? 2;
  }

  get storageGrant(): StorageGrant {
    return this.grant;
  }

  state(ref: FileRef): FileState {
    return this.states.get(keyOf(ref)) ?? { kind: "missing" };
  }

  /** Re-read every file's state from disk. Makes no network requests. */
  async refresh(): Promise<void> {
    for (const { model, file } of this.allFiles()) {
      const scan = await this.scan(model, file);
      this.setState(refOf(model, file), scan.ready ? { kind: "ready" } : scan.bytes > 0 ? { kind: "partial", bytes: scan.bytes } : { kind: "missing" });
    }
  }

  allReady(): boolean {
    return this.allFiles().every(({ model, file }) => this.state(refOf(model, file)).kind === "ready");
  }

  /** Download everything that is not verified yet. Throws StorageQuotaError before any fetch. */
  async ensureAll(signal?: AbortSignal): Promise<void> {
    await this.refresh();
    let needed = 0;
    for (const { model, file } of this.allFiles()) {
      const s = this.state(refOf(model, file));
      if (s.kind !== "ready") needed += file.size - (s.kind === "partial" ? s.bytes : 0);
    }
    if (needed > 0) await this.preflight(needed);
    for (const { model, file } of this.allFiles()) {
      await this.ensureFile(model, file, signal);
    }
  }

  async getBlob(modelId: string, path: string): Promise<Blob> {
    const { model, file } = this.find(modelId, path);
    const scan = await this.scan(model, file);
    if (!scan.ready) throw new Error(`${modelId}/${path} is not downloaded and verified`);
    const parts = await Promise.all(scan.names.map((n) => this.store.read(dirOf(model, file), n)));
    return new Blob(parts, { type: "application/octet-stream" });
  }

  /** Reads the whole file into memory; prefer getBlob/getObjectUrl for ~1 GB files. */
  async getArrayBuffer(modelId: string, path: string): Promise<ArrayBuffer> {
    return (await this.getBlob(modelId, path)).arrayBuffer();
  }

  /** The caller owns the URL and must `URL.revokeObjectURL` it. */
  async getObjectUrl(modelId: string, path: string): Promise<string> {
    return URL.createObjectURL(await this.getBlob(modelId, path));
  }

  private async preflight(needed: number): Promise<void> {
    if (this.storage?.persist !== undefined) {
      this.grant = (await this.storage.persist()) ? "persistent" : "best-effort";
    }
    const est = await this.storage?.estimate?.();
    if (est?.quota === undefined) return;
    const available = est.quota - (est.usage ?? 0);
    if (available < needed) throw new StorageQuotaError(needed, Math.max(0, available));
  }

  private async ensureFile(model: ModelSpec, file: FileSpec, signal: AbortSignal | undefined): Promise<void> {
    const ref = refOf(model, file);
    for (let attempt = 0; ; attempt++) {
      const scan = await this.scan(model, file);
      if (scan.ready) {
        this.setState(ref, { kind: "ready" });
        return;
      }
      try {
        const digest = await this.download(model, file, scan.bytes, signal);
        this.setState(ref, { kind: "verifying" });
        if (digest !== file.sha256) throw new CorruptDownload(`sha256 mismatch (got ${digest.slice(0, 12)}...)`);
        const marker = JSON.stringify({ sha256: file.sha256, size: file.size });
        await this.store.write(dirOf(model, file), MARKER, new TextEncoder().encode(marker));
        this.setState(ref, { kind: "ready" });
        return;
      } catch (e) {
        if (signal?.aborted === true) {
          await this.refresh();
          throw e;
        }
        if (e instanceof CorruptDownload) {
          await this.store.removeDir(dirOf(model, file));
          if (attempt < this.retries) continue;
          this.setState(ref, { kind: "failed", reason: `${e.message}; gave up after ${attempt + 1} attempts` });
          return;
        }
        if (this.manifest.fallbackEndpoint !== undefined && !this.onFallback) {
          // Resume the same file from the mirror, from the bytes already on disk.
          this.onFallback = true;
          continue;
        }
        this.setState(ref, { kind: "failed", reason: e instanceof Error ? e.message : String(e) });
        return;
      }
    }
  }

  /** Stores the file's bytes and returns their sha256. */
  private async download(model: ModelSpec, file: FileSpec, resumeAt: number, signal: AbortSignal | undefined): Promise<string> {
    const ref = refOf(model, file);
    const dir = dirOf(model, file);
    let hasher = new Sha256();
    let offset = resumeAt;
    // The hash state isn't persisted, so re-hash the prefix that is already on disk.
    for (let i = 0; i * this.chunk < offset; i++) {
      hasher.update(new Uint8Array(await (await this.store.read(dir, chunkName(i))).arrayBuffer()));
    }
    if (offset >= file.size) return hasher.digestHex();

    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined;
    const init: RequestInit = headers === undefined ? {} : { headers };
    if (signal !== undefined) init.signal = signal;
    const res = await this.fetchFn(fileUrl(this.manifest, model, file, this.onFallback ? this.manifest.fallbackEndpoint : undefined), init);
    if (res.status === 206) {
      const m = /^bytes (\d+)-/.exec(res.headers.get("Content-Range") ?? "");
      if (m?.[1] === undefined || Number(m[1]) !== offset) throw new Error("server returned the wrong byte range");
    } else if (res.status === 200) {
      if (offset > 0) {
        await this.store.removeDir(dir);
        hasher = new Sha256();
        offset = 0;
      }
    } else {
      throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    }
    if (res.body === null) throw new Error("response has no body");

    let index = Math.floor(offset / this.chunk);
    let received = offset;
    let pending: Uint8Array[] = [];
    let pendingLen = 0;
    const flush = async (bytes: Uint8Array): Promise<void> => {
      await this.store.write(dir, chunkName(index++), bytes);
    };
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > file.size) throw new CorruptDownload("server sent more bytes than the manifest size");
      hasher.update(value);
      pending.push(value);
      pendingLen += value.length;
      this.setState(ref, { kind: "partial", bytes: received });
      while (pendingLen >= this.chunk) {
        const joined = concat(pending, pendingLen);
        await flush(joined.subarray(0, this.chunk));
        const rest = joined.subarray(this.chunk);
        pending = rest.length > 0 ? [rest] : [];
        pendingLen = rest.length;
      }
    }
    if (received < file.size) throw new Error(`connection ended early at ${received} of ${file.size} bytes`);
    if (pendingLen > 0) await flush(concat(pending, pendingLen));
    return hasher.digestHex();
  }

  /**
   * Classifies what is on disk. Keeps only the longest valid chunk prefix and a marker that
   * still matches the manifest; anything else is deleted.
   */
  private async scan(model: ModelSpec, file: FileSpec): Promise<{ ready: boolean; bytes: number; names: string[] }> {
    const dir = dirOf(model, file);
    const entries = await this.store.list(dir);
    const byName = new Map(entries.map((e): [string, StoredEntry] => [e.name, e]));
    const names: string[] = [];
    let bytes = 0;
    for (let i = 0; bytes < file.size; i++) {
      const e = byName.get(chunkName(i));
      if (e === undefined || e.size !== Math.min(this.chunk, file.size - bytes)) break;
      names.push(e.name);
      bytes += e.size;
    }
    const keep = new Set(names);
    let ready = false;
    if (byName.has(MARKER)) {
      ready = bytes === file.size && (await this.markerMatches(dir, file));
      if (ready) keep.add(MARKER);
      else {
        // The bytes belong to a different manifest entry, so none of them can be a prefix of this one.
        await this.store.removeDir(dir);
        return { ready: false, bytes: 0, names: [] };
      }
    }
    for (const e of entries) if (!keep.has(e.name)) await this.store.remove(dir, e.name);
    return { ready, bytes, names };
  }

  private async markerMatches(dir: string, file: FileSpec): Promise<boolean> {
    try {
      const m: unknown = JSON.parse(await (await this.store.read(dir, MARKER)).text());
      return typeof m === "object" && m !== null && (m as { sha256?: unknown }).sha256 === file.sha256 && (m as { size?: unknown }).size === file.size;
    } catch {
      return false;
    }
  }

  private setState(ref: FileRef, state: FileState): void {
    this.states.set(keyOf(ref), state);
    this.opts.onState?.(ref, state);
  }

  private allFiles(): { model: ModelSpec; file: FileSpec }[] {
    return this.manifest.models.flatMap((model) => model.files.map((file) => ({ model, file })));
  }

  private find(modelId: string, path: string): { model: ModelSpec; file: FileSpec } {
    for (const hit of this.allFiles()) if (hit.model.id === modelId && hit.file.path === path) return hit;
    throw new Error(`${modelId}/${path} is not in the manifest`);
  }
}

function refOf(model: ModelSpec, file: FileSpec): FileRef {
  return { modelId: model.id, path: file.path };
}

function dirOf(model: ModelSpec, file: FileSpec): string {
  return `${model.id}/${encodeURIComponent(file.path)}`;
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

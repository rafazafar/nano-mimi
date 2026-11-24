import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "./blob-store";
import { aggregateRequirements, checkCapabilities, type GpuLike } from "./capability";
import { ModelStore } from "./model-store";
import { Sha256 } from "./sha256";
import { StorageQuotaError, fileUrl, parseManifest, type FileRef, type FileState, type Manifest } from "./types";

const CHUNK = 1024;
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface FakeServer {
  fetch: typeof fetch;
  requests: { url: string; range: string | null }[];
  /** Make the next response die after this many body bytes. */
  dieAfter: number | null;
  /** Serve this body instead of the real one, once. */
  corruptOnce: boolean;
  ignoreRange: boolean;
}

function fakeServer(body: Uint8Array): FakeServer {
  const server: FakeServer = {
    requests: [],
    dieAfter: null,
    corruptOnce: false,
    ignoreRange: false,
    fetch: async (input, init) => {
      const range = new Headers(init?.headers).get("Range");
      server.requests.push({ url: String(input), range });
      let data = body;
      if (server.corruptOnce) {
        data = body.slice();
        data[0] = data[0]! ^ 0xff;
        server.corruptOnce = false;
      }
      let start = 0;
      let status = 200;
      const headers = new Headers();
      if (range !== null && !server.ignoreRange) {
        start = Number(/bytes=(\d+)-/.exec(range)![1]);
        status = 206;
        headers.set("Content-Range", `bytes ${start}-${data.length - 1}/${data.length}`);
      }
      const slice = data.subarray(start);
      const limit = server.dieAfter;
      server.dieAfter = null;
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (limit !== null && sent >= limit) return controller.error(new TypeError("network error"));
          if (sent >= slice.length) return controller.close();
          const end = Math.min(sent + 300, slice.length, limit ?? Infinity);
          controller.enqueue(slice.subarray(sent, end));
          sent = end;
        },
      });
      return new Response(stream, { status, headers });
    },
  };
  return server;
}

function setup(size = CHUNK * 5 + 100, quota?: { quota: number; usage: number }) {
  const body = new Uint8Array(randomBytes(size));
  const manifest: Manifest = {
    endpoint: "https://mirror.test/",
    models: [{ id: "m", label: "M", repo: "org/m", revision: "main", files: [{ path: "dir/a.onnx", size, sha256: sha(body) }] }],
  };
  const server = fakeServer(body);
  const fs = new MemoryBlobStore();
  const events: [FileRef, FileState][] = [];
  const persistCalls = { n: 0 };
  const make = () =>
    new ModelStore({
      manifest,
      store: fs,
      fetch: server.fetch,
      chunkBytes: CHUNK,
      onState: (r, s) => events.push([r, s]),
      storage: {
        persist: async () => (persistCalls.n++, true),
        estimate: async () => quota ?? { quota: 1e12, usage: 0 },
      },
    });
  return { body, manifest, server, fs, events, make, ref: { modelId: "m", path: "dir/a.onnx" } };
}

describe("Sha256", () => {
  it.each([0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000])("matches node for %i bytes, any slicing", (n) => {
    const data = new Uint8Array(randomBytes(n));
    const h = new Sha256();
    for (let i = 0; i < n; i += 37) h.update(data.subarray(i, i + 37));
    expect(h.digestHex()).toBe(sha(data));
  });
});

describe("ModelStore", () => {
  it("downloads, verifies and returns the bytes", async () => {
    const t = setup();
    const store = t.make();
    await store.ensureAll();
    expect(store.state(t.ref)).toEqual({ kind: "ready" });
    expect(t.server.requests).toEqual([{ url: "https://mirror.test/org/m/resolve/main/dir/a.onnx", range: null }]);
    expect(t.events.map(([, s]) => s.kind)).toContain("verifying");
    expect(new Uint8Array(await store.getArrayBuffer("m", "dir/a.onnx"))).toEqual(t.body);
  });

  it("deletes and retries on a checksum mismatch", async () => {
    const t = setup();
    t.server.corruptOnce = true;
    const store = t.make();
    await store.ensureAll();
    expect(store.state(t.ref)).toEqual({ kind: "ready" });
    expect(t.server.requests).toHaveLength(2);
    expect(t.server.requests[1]!.range).toBeNull();
  });

  it("fails with a reason when every retry mismatches", async () => {
    const t = setup();
    const bad = fakeServer(new Uint8Array(t.body.length));
    const store = new ModelStore({ manifest: t.manifest, store: t.fs, fetch: bad.fetch, chunkBytes: CHUNK, mismatchRetries: 1 });
    await store.ensureAll();
    expect(store.state(t.ref)).toMatchObject({ kind: "failed", reason: expect.stringContaining("sha256 mismatch") });
    expect(bad.requests).toHaveLength(2);
    expect(await t.fs.list("m/dir%2Fa.onnx")).toEqual([]);
  });

  it("resumes an interrupted download from the bytes on disk", async () => {
    const t = setup();
    t.server.dieAfter = CHUNK * 2 + 500;
    const first = t.make();
    await first.ensureAll();
    expect(first.state(t.ref)).toMatchObject({ kind: "failed" });

    const second = t.make();
    await second.refresh();
    expect(second.state(t.ref)).toEqual({ kind: "partial", bytes: CHUNK * 2 });
    await second.ensureAll();
    expect(second.state(t.ref)).toEqual({ kind: "ready" });
    expect(t.server.requests[1]!.range).toBe(`bytes=${CHUNK * 2}-`);
    expect(new Uint8Array(await second.getArrayBuffer("m", "dir/a.onnx"))).toEqual(t.body);
  });

  it("resumes from the fallback endpoint when the primary drops mid-file", async () => {
    const t = setup();
    t.server.dieAfter = CHUNK * 2 + 500;
    const store = new ModelStore({ manifest: { ...t.manifest, fallbackEndpoint: "https://fallback.test" }, store: t.fs, fetch: t.server.fetch, chunkBytes: CHUNK });
    await store.ensureAll();
    expect(store.state(t.ref)).toEqual({ kind: "ready" });
    expect(t.server.requests.map((r) => [new URL(r.url).host, r.range])).toEqual([
      ["mirror.test", null],
      ["fallback.test", `bytes=${CHUNK * 2}-`],
    ]);
    expect(new Uint8Array(await store.getArrayBuffer("m", "dir/a.onnx"))).toEqual(t.body);
  });

  it("switches to the fallback endpoint when the primary answers with an error", async () => {
    const t = setup();
    const fetchFn: typeof fetch = async (input, init) =>
      new URL(String(input)).host === "mirror.test" ? new Response("down", { status: 503 }) : t.server.fetch(input, init);
    const store = new ModelStore({ manifest: { ...t.manifest, fallbackEndpoint: "https://fallback.test" }, store: t.fs, fetch: fetchFn, chunkBytes: CHUNK });
    await store.ensureAll();
    expect(store.state(t.ref)).toEqual({ kind: "ready" });
    expect(t.server.requests.map((r) => new URL(r.url).host)).toEqual(["fallback.test"]);
  });

  it("restarts from zero when the server ignores Range", async () => {
    const t = setup();
    t.server.dieAfter = CHUNK * 2 + 10;
    await t.make().ensureAll();
    t.server.ignoreRange = true;
    const store = t.make();
    await store.ensureAll();
    expect(store.state(t.ref)).toEqual({ kind: "ready" });
  });

  it("makes zero fetches when files are already verified", async () => {
    const t = setup();
    await t.make().ensureAll();
    t.server.requests.length = 0;
    const store = t.make();
    await store.ensureAll();
    expect(store.allReady()).toBe(true);
    expect(t.server.requests).toEqual([]);
  });

  it("discards verified data when the manifest hash changes", async () => {
    const t = setup();
    await t.make().ensureAll();
    t.server.requests.length = 0;
    const file = t.manifest.models[0]!.files[0]!;
    const changed: Manifest = { ...t.manifest, models: [{ ...t.manifest.models[0]!, files: [{ ...file, sha256: "0".repeat(64) }] }] };
    const store = new ModelStore({ manifest: changed, store: t.fs, fetch: t.server.fetch, chunkBytes: CHUNK, mismatchRetries: 0 });
    await store.refresh();
    expect(store.state(t.ref)).toEqual({ kind: "missing" });
  });

  it("errors on too little quota before any fetch", async () => {
    const t = setup(CHUNK * 5, { quota: 3000, usage: 500 });
    const store = t.make();
    await expect(store.ensureAll()).rejects.toThrow(StorageQuotaError);
    await expect(store.ensureAll()).rejects.toThrow(/Not enough browser storage/);
    expect(t.server.requests).toEqual([]);
  });

  it("counts resumed bytes against the quota need", async () => {
    const t = setup(CHUNK * 5);
    t.server.dieAfter = CHUNK * 4;
    await t.make().ensureAll();
    t.server.requests.length = 0;
    const store = new ModelStore({
      manifest: t.manifest,
      store: t.fs,
      fetch: t.server.fetch,
      chunkBytes: CHUNK,
      storage: { estimate: async () => ({ quota: CHUNK + 10, usage: 0 }) },
    });
    await store.ensureAll();
    expect(store.allReady()).toBe(true);
  });

  it("requests persistence only when there is something to download", async () => {
    const t = setup();
    const store = t.make();
    await store.ensureAll();
    expect(store.storageGrant).toBe("persistent");
  });
});

describe("manifest", () => {
  it("builds HF-style urls and honors a url override", () => {
    const m = parseManifest({
      models: [{ id: "a", label: "A", repo: "o/r", revision: "v1", files: [{ path: "x y/z.bin", size: 1, sha256: "a".repeat(64) }] }],
    });
    const model = m.models[0]!;
    expect(fileUrl(m, model, model.files[0]!)).toBe("https://huggingface.co/o/r/resolve/v1/x%20y/z.bin");
    expect(fileUrl({ ...m, endpoint: "https://e.test/api/" }, model, model.files[0]!)).toBe("https://e.test/api/o/r/resolve/v1/x%20y/z.bin");
    expect(fileUrl(m, model, { ...model.files[0]!, url: "https://cdn/x" })).toBe("https://cdn/x");
  });

  it("rejects malformed manifests", () => {
    expect(() => parseManifest({ models: [{ id: "a/b" }] })).toThrow(/id/);
    expect(() => parseManifest({ models: [{ id: "a", label: "A", repo: "r", revision: "m", files: [{ path: "p", size: 1, sha256: "zz" }] }] })).toThrow(/sha256/);
  });
});

describe("checkCapabilities", () => {
  const gpu = (over: { f16?: boolean; fallback?: boolean; buf?: number; bind?: number }): GpuLike => ({
    requestAdapter: async () => ({
      features: new Set(over.f16 === false ? [] : ["shader-f16"]),
      limits: { maxBufferSize: over.buf ?? 4e9, maxStorageBufferBindingSize: over.bind ?? 2e9 },
      info: { isFallbackAdapter: over.fallback ?? false },
    }),
  });
  const req = { shaderF16: true, minMaxBufferSize: 2e9, minMaxStorageBufferBindingSize: 1e9 };
  const codes = async (g: GpuLike | undefined) => (await checkCapabilities(g, req)).map((i) => i.code);

  it("passes a capable adapter", async () => expect(await codes(gpu({}))).toEqual([]));
  it("reports missing WebGPU and adapter", async () => {
    expect(await codes(undefined)).toEqual(["no-webgpu"]);
    expect(await codes({ requestAdapter: async () => null })).toEqual(["no-adapter"]);
  });
  it("reports fallback, f16 and limits", async () => {
    expect(await codes(gpu({ fallback: true, f16: false, buf: 1, bind: 1 }))).toEqual([
      "fallback-adapter",
      "no-shader-f16",
      "max-buffer-size",
      "max-storage-binding-size",
    ]);
  });
  it("aggregates the strictest model requirement", () => {
    const base = { revision: "r", repo: "r", label: "l", files: [] };
    const r = aggregateRequirements({
      models: [
        { ...base, id: "a", gpu: { shaderF16: false, minMaxBufferSize: 5, minMaxStorageBufferBindingSize: 1 } },
        { ...base, id: "b", gpu: { shaderF16: true, minMaxBufferSize: 2, minMaxStorageBufferBindingSize: 9 } },
        { ...base, id: "c" },
      ],
    });
    expect(r).toEqual({ shaderF16: true, minMaxBufferSize: 5, minMaxStorageBufferBindingSize: 9 });
  });
});

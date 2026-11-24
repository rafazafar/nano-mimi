import { describe, expect, it } from "vitest";
import { asrModels, HAAS_DECODER, PARAKEET_EN_DECODER, PARAKEET_EN_FP16, PARAKEET_EN_TABLES, HAAS_FP16, HAAS_INT8, HAAS_TABLES } from "../asr/models";
import { CAT_MODEL } from "../models/manifest";
import type { FileState } from "../models/types";
import { BACKEND_KEY, MIRROR_ENDPOINT, buildManifest, downloadProgress, fileKey, parseBackend, describeEndpoint, parseEndpointParam, setupActionLabel } from "./setupModel";

describe("parseEndpointParam", () => {
  it("is the default without the parameter", () => {
    expect(parseEndpointParam("")).toEqual({ kind: "default" });
    expect(parseEndpointParam("?other=1")).toEqual({ kind: "default" });
    expect(parseEndpointParam("?endpoint=")).toEqual({ kind: "default" });
  });

  it("accepts http(s) and trims the slash, query and fragment", () => {
    expect(parseEndpointParam("?endpoint=http://localhost:8123")).toEqual({ kind: "custom", url: "http://localhost:8123" });
    expect(parseEndpointParam("?endpoint=https%3A%2F%2Fmirror.example%2Fhf%2F%3Fx%3D1%23y")).toEqual({
      kind: "custom",
      url: "https://mirror.example/hf",
    });
  });

  it("rejects other schemes, credentials and junk", () => {
    expect(parseEndpointParam("?endpoint=javascript:alert(1)").kind).toBe("invalid");
    expect(parseEndpointParam("?endpoint=file:///etc/passwd").kind).toBe("invalid");
    expect(parseEndpointParam("?endpoint=https://user:pw@mirror.example").kind).toBe("invalid");
    expect(parseEndpointParam("?endpoint=not a url")).toEqual({ kind: "invalid", raw: "not a url" });
  });
});

describe("buildManifest", () => {
  it("lists the backend's ASR files and the translator; the mirror backs the default endpoint, not a custom one", () => {
    expect(buildManifest("webgpu", { kind: "default" }, "ja-en")).toEqual({
      fallbackEndpoint: MIRROR_ENDPOINT,
      models: [HAAS_TABLES, HAAS_FP16, HAAS_DECODER, CAT_MODEL],
    });
    expect(buildManifest("wasm", { kind: "custom", url: "http://localhost:9" }, "ja-en")).toEqual({
      endpoint: "http://localhost:9",
      models: [HAAS_TABLES, HAAS_INT8, HAAS_DECODER, CAT_MODEL],
    });
    expect(buildManifest("webgpu", { kind: "invalid", raw: "x" }, "ja-en").endpoint).toBeUndefined();
    expect(buildManifest("wasm", { kind: "default" }, "ja-en").models).toEqual([...asrModels("ja-en", "wasm"), CAT_MODEL]);
  });

  it("swaps in the English recognizer for en-ja and keeps the same translator", () => {
    expect(buildManifest("webgpu", { kind: "default" }, "en-ja").models).toEqual([PARAKEET_EN_TABLES, PARAKEET_EN_FP16, PARAKEET_EN_DECODER, CAT_MODEL]);
  });
});

describe("parseBackend", () => {
  it("takes only the two known backends", () => {
    expect(BACKEND_KEY).toBe("mimivox.asr-backend.v1");
    expect(parseBackend("webgpu")).toBe("webgpu");
    expect(parseBackend("wasm")).toBe("wasm");
    expect(parseBackend("cpu")).toBeNull();
    expect(parseBackend(null)).toBeNull();
  });
});

describe("downloadProgress", () => {
  const manifest = buildManifest("webgpu", { kind: "default" }, "ja-en");
  const states = (entries: [string, string, FileState][]): Map<string, FileState> =>
    new Map(entries.map(([modelId, path, state]) => [fileKey({ modelId, path }), state]));

  it("starts at zero with every file missing", () => {
    const p = downloadProgress(manifest, new Map());
    expect(p.doneBytes).toBe(0);
    expect(p.fraction).toBe(0);
    expect(p.models.map((m) => m.id)).toEqual(manifest.models.map((m) => m.id));
    expect(p.failures).toEqual([]);
  });

  it("counts verified and verifying files in full and partial ones by bytes received", () => {
    const encoderSize = HAAS_FP16.files[1]!.size;
    const p = downloadProgress(
      manifest,
      states([
        [HAAS_FP16.id, "fp16/encoder.onnx", { kind: "ready" }],
        [HAAS_FP16.id, "fp16/encoder.onnx.data", { kind: "partial", bytes: encoderSize / 2 }],
        [HAAS_DECODER.id, "fp32/decoder_joint.onnx", { kind: "verifying" }],
      ]),
    );
    const fp16 = p.models.find((m) => m.id === HAAS_FP16.id)!;
    expect(fp16.doneBytes).toBe(HAAS_FP16.files[0]!.size + encoderSize / 2);
    expect(p.models.find((m) => m.id === HAAS_DECODER.id)!.files[0]!.doneBytes).toBe(HAAS_DECODER.files[0]!.size);
    expect(p.fraction).toBeGreaterThan(0);
    expect(p.fraction).toBeLessThan(1);
  });

  it("never counts more than a file's size and surfaces failures with their reason", () => {
    const first = HAAS_TABLES.files[0]!;
    const p = downloadProgress(
      manifest,
      states([
        [HAAS_TABLES.id, first.path, { kind: "partial", bytes: first.size * 3 }],
        [CAT_MODEL.id, "config.json", { kind: "failed", reason: "HTTP 404" }],
      ]),
    );
    expect(p.models[0]!.files[0]!.doneBytes).toBe(first.size);
    expect(p.failures).toEqual(["config.json: HTTP 404"]);
  });

  it("reaches exactly one when everything is ready", () => {
    const all = manifest.models.flatMap((m) => m.files.map((f): [string, string, FileState] => [m.id, f.path, { kind: "ready" }]));
    expect(downloadProgress(manifest, states(all)).fraction).toBe(1);
  });
});

describe("setupActionLabel", () => {
  it("offers to load when everything is on disk", () => {
    expect(setupActionLabel({ totalBytes: 600_000_000, missingBytes: 0 })).toBe("Load models");
  });

  it("offers to resume when some is on disk, with what is left", () => {
    expect(setupActionLabel({ totalBytes: 600_000_000, missingBytes: 150_000_000 })).toMatch(/^Resume download, .+ left$/);
  });

  it("offers a full download when nothing is on disk, with the total", () => {
    expect(setupActionLabel({ totalBytes: 600_000_000, missingBytes: 600_000_000 })).toMatch(/^Download \d/);
  });
});

describe("describeEndpoint", () => {
  it("names the default host", () => {
    expect(describeEndpoint({ kind: "default" })).toBe("Downloads come from huggingface.co.");
  });

  it("names a custom endpoint", () => {
    expect(describeEndpoint({ kind: "custom", url: "https://mirror.example.com/hf" })).toContain("https://mirror.example.com/hf");
  });

  it("says an unusable endpoint was ignored and shortens a long one", () => {
    const text = describeEndpoint({ kind: "invalid", raw: `javascript:${"x".repeat(300)}` });
    expect(text).toContain("was ignored");
    expect(text).toContain("huggingface.co");
    expect(text.length).toBeLessThan(260);
  });
});

#!/usr/bin/env node
// Copies the browser app's commit-pinned model files from huggingface.co into the
// mimivox-models R2 bucket, which workers/hf-proxy serves as a fallback.
//
//   node scripts/seed_model_mirror.mjs [--web <dir>] [--dry-run] [--keep-uploader]
//
// The model list comes from the web app itself: <web>/src/models/manifest.ts
// (DEFAULT_MANIFEST) plus ASR_MODELS from <web>/src/asr/models.ts when exported.
// <web> defaults to ./web. Only files whose revision is a 40-hex commit sha are
// copied. Each is skipped when R2 already holds an object of the manifest size,
// and is checked against the manifest sha256 before it is committed to R2.
//
// Uploads go through a throwaway worker (workers/hf-proxy, SEED_UPLOADER=1) that
// holds the R2 binding, so no R2 API credentials are needed beyond `cf auth login`.
// It is deployed with a random bearer token and deleted when the run ends.
// Rerunning is safe: finished files are skipped, interrupted uploads start over.
//
// Needs Node 22.6+ (type stripping) and CLOUDFLARE_ACCOUNT_ID if your login has
// several accounts.

import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = join(REPO_ROOT, "workers", "hf-proxy");
const UPLOADER_NAME = "mimivox-model-seed";
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const PART_SIZE = 32 * 1024 * 1024;
const CONTENT_TYPES = { ".json": "application/json", ".onnx": "application/octet-stream", ".txt": "text/plain" };

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const webDir = resolve(option("--web") ?? join(REPO_ROOT, "web"));

// The web sources import each other without file extensions; resolve them as .ts.
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
      try { return await next(specifier, context); }
      catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".")) return next(specifier + ".ts", context);
        throw error;
      }
    }`),
  import.meta.url,
);

async function loadFiles() {
  const manifest = await import(pathToFileURL(join(webDir, "src/models/manifest.ts")));
  const specs = [...manifest.DEFAULT_MANIFEST.models];
  const asrPath = join(webDir, "src/asr/models.ts");
  if (existsSync(asrPath)) {
    const asr = await import(pathToFileURL(asrPath));
    for (const group of Object.values(asr.ASR_MODELS ?? {})) specs.push(...group);
  }
  const files = new Map();
  for (const spec of specs) {
    for (const file of spec.files) {
      const key = `${spec.repo}/${spec.revision}/${file.path}`;
      files.set(key, { key, repo: spec.repo, revision: spec.revision, ...file });
    }
  }
  return [...files.values()];
}

function deployUploader(token) {
  const dir = mkdtempSync(join(tmpdir(), "mimivox-seed-"));
  const secrets = join(dir, "secrets.env");
  writeFileSync(secrets, `UPLOAD_TOKEN=${token}\n`, { mode: 0o600 });
  try {
    const run = spawnSync("npx", ["cf", "deploy", "--secrets-file", secrets], {
      cwd: WORKER_DIR,
      env: { ...process.env, SEED_UPLOADER: "1" },
      encoding: "utf8",
    });
    const out = `${run.stdout}${run.stderr}`;
    if (run.status !== 0) throw new Error(`cf deploy failed:\n${out}`);
    const url = out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
    if (!url) throw new Error(`No workers.dev URL in deploy output:\n${out}`);
    return url;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function deleteUploader() {
  execFileSync("npx", ["cf", "workers", "delete", UPLOADER_NAME, "--force"], { cwd: WORKER_DIR, stdio: "inherit" });
}

class Uploader {
  constructor(base, token) {
    this.base = base;
    this.auth = { authorization: `Bearer ${token}` };
  }

  async call(method, path, params, body) {
    const url = `${this.base}${path}?${new URLSearchParams(params)}`;
    const init = { method, headers: { ...this.auth }, body };
    // A fresh deploy can take a few seconds to answer.
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, init);
        const text = res.status === 204 ? "" : await res.text();
        // 404 "missing" is the uploader's answer; any other 404 is a deploy that is not live yet.
        if (res.status === 404 && path === "/head" && text === "missing") return null;
        if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
        return text ? JSON.parse(text) : null;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((done) => setTimeout(done, 2000 * attempt));
      }
    }
  }
}

async function hubStream(file) {
  const url = `https://huggingface.co/${file.repo}/resolve/${file.revision}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Hub ${res.status} for ${url}`);
  return res.body;
}

// Re-chunks the download into PART_SIZE buffers (the last one may be smaller).
async function* chunks(stream) {
  let pending = [];
  let held = 0;
  for await (const piece of stream) {
    pending.push(piece);
    held += piece.length;
    while (held >= PART_SIZE) {
      const all = Buffer.concat(pending);
      yield all.subarray(0, PART_SIZE);
      pending = [all.subarray(PART_SIZE)];
      held = all.length - PART_SIZE;
    }
  }
  if (held > 0) yield Buffer.concat(pending);
}

async function copyFile(uploader, file) {
  const type = CONTENT_TYPES[extname(file.path)] ?? "application/octet-stream";
  const hash = createHash("sha256");
  const params = { key: file.key, type };
  let uploadId = null;
  const parts = [];
  let total = 0;
  let first = null;
  try {
    for await (const chunk of chunks(await hubStream(file))) {
      hash.update(chunk);
      total += chunk.length;
      if (first === null && total <= PART_SIZE && chunk.length === total) {
        // Hold the first chunk: a file that fits in it is uploaded in one request.
        first = chunk;
        continue;
      }
      if (uploadId === null) {
        ({ uploadId } = await uploader.call("POST", "/mpu/create", params));
        parts.push(await uploader.call("PUT", "/mpu/part", { ...params, uploadId, n: 1 }, first));
      }
      const n = parts.length + 1;
      parts.push(await uploader.call("PUT", "/mpu/part", { ...params, uploadId, n }, chunk));
      process.stdout.write(`\r  ${file.path}: ${(total / 1048576).toFixed(0)} / ${(file.size / 1048576).toFixed(0)} MiB`);
    }
    if (total !== file.size) throw new Error(`size ${total}, manifest says ${file.size}`);
    const digest = hash.digest("hex");
    if (digest !== file.sha256) throw new Error(`sha256 ${digest}, manifest says ${file.sha256}`);
    if (uploadId === null) {
      await uploader.call("PUT", "/put", params, first);
    } else {
      await uploader.call("POST", "/mpu/complete", { ...params, uploadId }, JSON.stringify({ parts }));
    }
  } catch (error) {
    if (uploadId) await uploader.call("POST", "/mpu/abort", { ...params, uploadId }).catch(() => {});
    throw error;
  }
}

const all = await loadFiles();
const pinned = all.filter((file) => COMMIT_SHA.test(file.revision));
const skipped = all.length - pinned.length;
console.log(`${pinned.length} pinned files in the manifest; ${skipped} on non-sha revisions are not mirrored.`);
if (flag("--dry-run")) {
  for (const file of pinned) console.log(`  ${file.key}  ${file.size} bytes`);
  process.exit(0);
}

const token = randomBytes(24).toString("hex");
const base = deployUploader(token);
const uploader = new Uploader(base, token);
let failed = 0;
try {
  for (const file of pinned) {
    const head = await uploader.call("GET", "/head", { key: file.key });
    if (head?.size === file.size) {
      console.log(`skip  ${file.key} (already in R2)`);
      continue;
    }
    try {
      await copyFile(uploader, file);
      console.log(`\rdone  ${file.key} (${file.size} bytes)${" ".repeat(20)}`);
    } catch (error) {
      failed++;
      console.error(`\nFAIL  ${file.key}: ${error.message}`);
    }
  }
} finally {
  if (!flag("--keep-uploader")) deleteUploader();
}
process.exit(failed ? 1 : 0);

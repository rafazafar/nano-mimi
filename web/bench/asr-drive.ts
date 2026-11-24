// Drives bench/asr.html in real Chrome over the 100 S0b FLEURS clips.
//
//   node bench/asr-drive.ts <name> [--backend webgpu|wasm] [--threads 4] [--n 100] [--passes 3] [--warmup 3] [--unsafe-webgpu]
//
// Needs `web/.models` (scripts/build_web_asr_models.py) and `web/.bench` (scripts/export_asr_web_fixtures.py).
// Serves web/.models as the model-store endpoint and web/.bench as the clips from a local static
// server, runs Vite with cross-origin isolation, and keeps a persistent Chrome profile so OPFS
// holds the models between runs. Writes web/.bench/results/<name>.json; score it with
// `uv run python web/bench/asr_score.py <name>`. Exits non-zero unless the page was
// crossOriginIsolated and, on webgpu, the adapter was a real (non-fallback) one.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { createServer as createViteServer } from "vite";
import { serveRoots } from "./serve.ts";

const WEB = new URL("..", import.meta.url).pathname;
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    backend: { type: "string", default: "webgpu" },
    threads: { type: "string", default: "4" },
    n: { type: "string", default: "100" },
    passes: { type: "string", default: "3" },
    warmup: { type: "string", default: "3" },
    "unsafe-webgpu": { type: "boolean", default: false },
  },
});
const name = positionals[0];
if (name === undefined) throw new Error("usage: node bench/asr-drive.ts <name> [options]");

const files = await serveRoots({ models: join(WEB, ".models"), clips: join(WEB, ".bench") });
const filesOrigin = files.origin;

const vite = await createViteServer({
  root: WEB,
  logLevel: "warn",
  // Pre-bundling ORT on first import reloads the page mid-run and breaks its wasm path resolution.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  server: {
    port: 0,
    host: "127.0.0.1",
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" },
  },
});
await vite.listen();
const pageUrl = `${vite.resolvedUrls!.local[0]!}bench/asr.html`;

const outDir = join(WEB, ".bench", "results");
mkdirSync(outDir, { recursive: true });
const consoleLines: string[] = [];
const context = await chromium.launchPersistentContext(join(WEB, ".bench", "chrome-profile"), {
  channel: "chrome",
  headless: false,
  // Off by default: users run stock Chrome, which hides the chromium-experimental-* WebGPU features.
  args: values["unsafe-webgpu"] ? ["--enable-unsafe-webgpu"] : [],
});
let failed = false;
try {
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
  page.on("worker", (w) => w.on("console", (m) => consoleLines.push(`[worker:${m.type()}] ${m.text()}`)));
  page.setDefaultTimeout(0);
  await page.goto(pageUrl);
  await page.waitForFunction(() => window.asrBench !== undefined);
  const cfg = {
    endpoint: `${filesOrigin}/models`,
    clips: `${filesOrigin}/clips`,
    backend: values.backend,
    threads: Number(values.threads),
    n: Number(values.n),
    passes: Number(values.passes),
    warmup: Number(values.warmup),
  };
  const started = Date.now();
  const result = (await page.evaluate((c) => window.asrBench!(c as never), cfg)) as {
    device: { crossOriginIsolated: boolean; adapter?: { isFallbackAdapter: boolean } };
    passes: { ms: number }[][];
  };
  const out = { name, cfg, chrome: context.browser()?.version() ?? null, wallS: (Date.now() - started) / 1000, result, console: consoleLines };
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(out));
  const { device } = result;
  if (!device.crossOriginIsolated) failed = true;
  if (values.backend === "webgpu" && device.adapter?.isFallbackAdapter !== false) failed = true;
  const p50s = result.passes.map((rows) => [...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)]!.toFixed(1));
  console.log(JSON.stringify({ name, device, p50s, wallS: out.wallS, ok: !failed }));
} catch (e) {
  failed = true;
  console.error(e);
  console.error(consoleLines.slice(-20).join("\n"));
} finally {
  await context.close();
  await vite.close();
  files.close();
}
process.exit(failed ? 1 : 0);

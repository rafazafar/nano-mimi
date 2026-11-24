// Drives the real app in headed Chrome over a WAV played through Chrome's fake microphone.
//
//   node bench/live-drive.ts <name> --wav <path> [--runs 3] [--source mic|file] [--backend webgpu|wasm] [--screens] [--memory] [--unsafe-webgpu]
//
// Serves web/.models as the model-store endpoint (the CAT files are linked in under the repo and revision
// the manifest names), runs Vite with cross-origin isolation, and keeps a persistent Chrome profile so OPFS
// holds the models between runs. The first run downloads them through the setup screen.
// Each run presses Start, lets the file play to its end, presses Stop and reads the caption rows from the page.
// --source file picks the WAV in the app's own file picker instead and lets the replay end the session by itself.
// --screens takes screenshots of the live view and the Document Picture-in-Picture window into web/.bench/screens/.
// --memory samples the Chrome GPU process footprint every 3 s, the way S0a did (the sampling slows decode, so do not time that run).
// Writes web/.bench/results/<name>.json; compare it to the Python pipeline with `uv run python web/bench/live_compare.py`.
// Exits non-zero unless the page was crossOriginIsolated and the adapter was a real (non-fallback) one.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Page } from "@playwright/test";
import { createServer as createViteServer } from "vite";
import { serveRoots } from "./serve.ts";

const WEB = new URL("..", import.meta.url).pathname;
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    wav: { type: "string" },
    runs: { type: "string", default: "1" },
    source: { type: "string", default: "mic" },
    backend: { type: "string", default: "" },
    screens: { type: "boolean", default: false },
    memory: { type: "boolean", default: false },
    "unsafe-webgpu": { type: "boolean", default: false },
    port: { type: "string", default: process.env["WEB_LIVE_PORT"] ?? "5199" },
  },
});
const name = positionals[0];
if (name === undefined || values.wav === undefined) throw new Error("usage: node bench/live-drive.ts <name> --wav <path> [options]");
const wavPath = resolve(values.wav);
const runs = Number(values.runs);
const SCREENS = join(WEB, ".bench", "screens");
const RESULTS = join(WEB, ".bench", "results");
mkdirSync(SCREENS, { recursive: true });
mkdirSync(RESULTS, { recursive: true });

/** Seconds of audio in a PCM WAV, from its fmt and data chunks. */
function wavSeconds(path: string): number {
  const b = readFileSync(path);
  let at = 12;
  let rate = 0;
  let frame = 0;
  while (at + 8 <= b.length) {
    const id = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === "fmt ") {
      rate = b.readUInt32LE(at + 12);
      frame = b.readUInt16LE(at + 20);
    }
    if (id === "data") return size / (rate * frame);
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no data chunk`);
}
const audioS = wavSeconds(wavPath);

const files = await serveRoots({ models: join(WEB, ".models") });
const vite = await createViteServer({
  root: WEB,
  logLevel: "warn",
  server: { port: Number(values.port), strictPort: true, host: "127.0.0.1" },
});
await vite.listen();
const appOrigin = vite.resolvedUrls!.local[0]!.replace(/\/$/, "");

// The CAT repo is not published: link the local export where the manifest expects it on the endpoint.
const { CAT_MODEL } = (await vite.ssrLoadModule("/src/models/manifest.ts")) as { CAT_MODEL: { repo: string; revision: string } };
const catSource = process.env["MIMIVOX_CAT_DIR"] ?? join(homedir(), ".cache/mimivox/web-models/cat-ogb-q4");
const catLink = join(WEB, ".models", CAT_MODEL.repo, "resolve", CAT_MODEL.revision);
if (!existsSync(catLink)) {
  if (!existsSync(catSource)) throw new Error(`CAT export not found at ${catSource} (set MIMIVOX_CAT_DIR)`);
  mkdirSync(dirname(catLink), { recursive: true });
  symlinkSync(catSource, catLink, "dir");
}

const profile = join(WEB, ".bench", "chrome-profile");
const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1280, height: 800 },
  colorScheme: "dark",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${wavPath}%noloop`,
    // Off by default: users run stock Chrome, which hides the chromium-experimental-* WebGPU features.
    ...(values["unsafe-webgpu"] ? ["--enable-unsafe-webgpu"] : []),
  ],
});

const consoleLines: string[] = [];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForStatus(page: Page, wanted: readonly string[], timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = ((await page.locator('[data-role="status-label"]').textContent().catch(() => null)) ?? "").trim();
    if (wanted.some((w) => text.startsWith(w))) return text;
    if (text === "Needs attention") {
      const why = await page.locator('[data-role="fatal-error"]').textContent().catch(() => null);
      throw new Error(`app needs attention: ${why ?? "unknown"}`);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${wanted.join(" or ")}; status is "${text}"`);
    await sleep(500);
  }
}

/** `footprint` of the GPU helper that belongs to this run's Chrome, in MB. */
function gpuFootprintMb(): number | null {
  const ps = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const line = ps.split("\n").find((l) => l.includes("--type=gpu-process") && l.includes(profile));
  const pid = line?.trim().split(/\s+/)[0];
  if (pid === undefined) return null;
  const out = execFileSync("footprint", ["-p", pid], { encoding: "utf8" });
  const m = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/i.exec(out);
  if (m === null) return null;
  const n = Number(m[1]);
  return m[2]!.toUpperCase() === "GB" ? n * 1024 : m[2]!.toUpperCase() === "KB" ? n / 1024 : n;
}

interface RowRead {
  readonly id: number;
  readonly status: string | undefined;
  readonly source: string | undefined;
  readonly revisions: number;
  readonly ja: string;
  readonly en: string;
  readonly time: string;
  readonly timing: Record<string, string>;
}

const readRows = (page: Page): Promise<RowRead[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".row[data-row-id]")].map((el) => ({
      id: Number(el.dataset["rowId"]),
      status: el.dataset["status"],
      source: el.dataset["source"],
      revisions: Number(el.dataset["revisions"] ?? 0),
      ja: el.querySelector(".row-ja")?.textContent ?? "",
      en: el.querySelector(".en-text")?.textContent ?? "",
      time: el.querySelector(".row-time")?.textContent ?? "",
      timing: Object.fromEntries(
        [...el.querySelectorAll(".timing-list dt")].map((dt) => [dt.textContent ?? "", dt.nextElementSibling?.textContent ?? ""]),
      ),
    })),
  );

const field = (page: Page, key: string): Promise<string> =>
  page.locator(`[data-field="${key}"]`).first().textContent({ timeout: 2000 }).then((t) => t ?? "", () => "");

async function screenshotPip(page: Page, path: string): Promise<boolean> {
  const known = new Set(context.pages());
  const button = page.locator('[data-role="pip"]');
  if (!(await button.isEnabled())) return false;
  await button.click();
  let pip: Page | undefined;
  for (let i = 0; i < 30 && pip === undefined; i++) {
    pip = context.pages().find((p) => !known.has(p));
    if (pip === undefined) await sleep(200);
  }
  if (pip === undefined) return false;
  await pip.setViewportSize({ width: 460, height: 320 });
  await sleep(600);
  await pip.screenshot({ path });
  await pip.close();
  await sleep(300);
  return true;
}

let failed = false;
const out: Record<string, unknown> = { name, wav: wavPath, audioS, chrome: context.browser()?.version() ?? null, runs: [] as unknown[] };
const footprints: { tS: number; mb: number | null }[] = [];
try {
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
  page.on("worker", (w) => w.on("console", (m) => consoleLines.push(`[worker:${m.type()}] ${m.text()}`)));
  page.setDefaultTimeout(0);
  if (values.backend !== "") {
    await page.addInitScript((b) => localStorage.setItem("mimivox.asr-backend.v1", b), values.backend);
  }

  const loadStarted = Date.now();
  await page.goto(`${appOrigin}/?endpoint=${encodeURIComponent(`${files.origin}/models`)}`);
  const first = await waitForStatus(page, ["Setup needed", "Ready"], 10 * 60_000);
  if (first === "Setup needed") {
    await page.locator('[data-role="download"]').click();
    await waitForStatus(page, ["Ready"], 20 * 60_000);
  }
  out["loadWallS"] = (Date.now() - loadStarted) / 1000;

  const env = {
    crossOriginIsolated: await page.evaluate(() => crossOriginIsolated),
    fallbackAdapter: await field(page, "fallback adapter"),
    asrBackend: await field(page, "asr-backend"),
    asrDevice: await field(page, "asr-device"),
    mtRuntime: await field(page, "mt-runtime"),
    mtAdapter: await field(page, "mt-adapter"),
    loadVad: await field(page, "load-vad"),
    loadAsr: await field(page, "load-asr"),
    loadMt: await field(page, "load-mt"),
  };
  out["env"] = env;
  console.log(JSON.stringify(env));
  if (!env.crossOriginIsolated) failed = true;
  if (values.backend !== "wasm" && (env.fallbackAdapter !== "false" || env.asrDevice.includes("fallback"))) failed = true;

  const start = page.locator('[data-role="start"]');
  const fromFile = values.source === "file";
  if (fromFile) {
    await page.locator('[data-role="source"] label', { hasText: "WAV file" }).click();
    await page.locator('[data-role="file-input"]').setInputFiles(wavPath);
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-role="start"]')?.disabled);
  }
  for (let i = 0; i < runs; i++) {
    const started = Date.now();
    await start.click();
    await waitForStatus(page, ["Live"], 60_000);
    const t0 = Date.now();
    let pipOk = false;
    let shotLive = false;
    let sampled = 0;
    while ((Date.now() - t0) / 1000 < audioS + 2.5) {
      const elapsed = (Date.now() - t0) / 1000;
      if (values.memory && elapsed >= sampled * 3) {
        footprints.push({ tS: elapsed, mb: gpuFootprintMb() });
        sampled++;
      }
      if (values.screens && i === runs - 1 && !shotLive && elapsed >= Math.min(20, audioS * 0.6)) {
        await page.screenshot({ path: join(SCREENS, `${name}-live.png`) });
        pipOk = await screenshotPip(page, join(SCREENS, `${name}-pip.png`));
        shotLive = true;
      }
      await sleep(250);
    }
    if (values.screens && i === runs - 1) await page.screenshot({ path: join(SCREENS, `${name}-end.png`) });
    if (!fromFile) await start.click();
    await waitForStatus(page, ["Ready"], 120_000);
    const rows = await readRows(page);
    (out["runs"] as unknown[]).push({ index: i, wallS: (Date.now() - started) / 1000, pipScreenshot: pipOk, rows });
    console.log(`run ${i}: ${rows.length} rows, ${rows.filter((r) => r.en === "").length} empty English`);
  }
  if (values.memory) out["gpuFootprintMb"] = footprints;
  const pageErrors = consoleLines.filter((l) => l.startsWith("[pageerror]") || l.startsWith("[error]"));
  if (pageErrors.length > 0) console.log(`page errors:\n${pageErrors.slice(0, 10).join("\n")}`);
} catch (e) {
  failed = true;
  console.error(e);
  console.error(consoleLines.slice(-30).join("\n"));
} finally {
  out["console"] = consoleLines;
  writeFileSync(join(RESULTS, `${name}.json`), JSON.stringify(out));
  await context.close();
  await vite.close();
  files.close();
}
process.exit(failed ? 1 : 0);

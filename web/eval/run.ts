// Runs the real web app in headed Chrome over the eval inputs at 1x and writes the caption rows it logged.
//
//   node eval/run.ts --inputs <dir> --out <rows.json> [--clips-via file|mic] [--meetings-via mic|file]
//                    [--limit-clips N] [--limit-meetings N] [--no-clips] [--no-meetings] [--unsafe-webgpu]
//
// <dir> comes from `scripts/eval/web_eval.py prepare`. Score the rows with `web_eval.py score --rows <rows.json>`.
// Like bench/live-drive.ts it serves web/.models as the model endpoint, runs Vite with cross-origin isolation, keeps a
// persistent Chrome profile so OPFS holds the models, and exits non-zero unless the page was crossOriginIsolated on a
// real (non-fallback) WebGPU adapter. The page is eval/index.html: the app itself, plus a log of its pipeline events.
//
// Meetings go through Chrome's fake microphone (`--use-file-for-fake-audio-capture`), one Chrome launch per meeting,
// because a launch plays one file. That is the path a user's microphone takes, under the live queue policy. Clips go
// through the app's WAV-file source in one warm page: it replays at 1x through the same capture path, one fresh
// session per clip (empty cache and context, as in run_eval.py), and avoids a Chrome launch per clip.
// `--clips-via mic` runs clips through the fake microphone too.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { arch, cpus, homedir, platform, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { createServer as createViteServer } from "vite";
import { serveRoots } from "../bench/serve.ts";
import type { SessionRecord } from "./rowLog.ts";

const WEB = new URL("..", import.meta.url).pathname;
const { values } = parseArgs({
  options: {
    inputs: { type: "string" },
    out: { type: "string" },
    "clips-via": { type: "string", default: "file" },
    "meetings-via": { type: "string", default: "mic" },
    "limit-clips": { type: "string" },
    "limit-meetings": { type: "string" },
    "no-clips": { type: "boolean", default: false },
    "no-meetings": { type: "boolean", default: false },
    "unsafe-webgpu": { type: "boolean", default: false },
    port: { type: "string", default: process.env["WEB_EVAL_PORT"] ?? "5198" },
  },
});
if (values.inputs === undefined || values.out === undefined) throw new Error("usage: node eval/run.ts --inputs <dir> --out <rows.json> [options]");
type Via = "mic" | "file";
const asVia = (v: string, flag: string): Via => {
  if (v !== "mic" && v !== "file") throw new Error(`--${flag} must be mic or file, got ${v}`);
  return v;
};
const clipsVia = asVia(values["clips-via"], "clips-via");
const meetingsVia = asVia(values["meetings-via"], "meetings-via");
const inputs = resolve(values.inputs);
const outPath = resolve(values.out);
mkdirSync(dirname(outPath), { recursive: true });

interface Item {
  readonly file: string;
  readonly seconds: number;
}
interface Manifest {
  readonly clips: readonly (Item & { readonly sid: string })[];
  readonly meetings: readonly (Item & { readonly name: string })[];
}
const manifest = JSON.parse(readFileSync(join(inputs, "manifest.json"), "utf8")) as Manifest;
const limit = values["limit-clips"] === undefined ? Infinity : Number(values["limit-clips"]);
const clips = values["no-clips"] ? [] : manifest.clips.slice(0, limit);
const meetings = values["no-meetings"] ? [] : manifest.meetings.slice(0, values["limit-meetings"] === undefined ? Infinity : Number(values["limit-meetings"]));

const files = await serveRoots({ models: join(WEB, ".models") });
const vite = await createViteServer({
  root: WEB,
  logLevel: "warn",
  server: { port: Number(values.port), strictPort: true, host: "127.0.0.1" },
});
await vite.listen();
const appUrl = `${vite.resolvedUrls!.local[0]!.replace(/\/$/, "")}/eval/index.html?endpoint=${encodeURIComponent(`${files.origin}/models`)}`;

/** The CAT export is not published: link the local one where the manifest expects it on the endpoint. */
function linkLocalCatExport(cat: { repo: string; revision: string }): void {
  const source = process.env["MIMIVOX_CAT_DIR"] ?? join(homedir(), ".cache/mimivox/web-models/cat-ogb-q4");
  const link = join(WEB, ".models", cat.repo, "resolve", cat.revision);
  if (existsSync(link)) return;
  if (!existsSync(source)) throw new Error(`CAT export not found at ${source} (set MIMIVOX_CAT_DIR)`);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(source, link, "dir");
}
const { CAT_MODEL } = (await vite.ssrLoadModule("/src/models/manifest.ts")) as { CAT_MODEL: { repo: string; revision: string } };
linkLocalCatExport(CAT_MODEL);

const profile = join(WEB, ".bench", "eval-profile");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const progress = (line: string): void => void process.stderr.write(`${line}\n`);

function launch(fakeMicWav: string | null): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    args: [
      "--use-fake-ui-for-media-stream",
      ...(fakeMicWav === null ? [] : ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fakeMicWav}%noloop`]),
      // Off by default: users run stock Chrome, which hides the chromium-experimental-* WebGPU features.
      ...(values["unsafe-webgpu"] ? ["--enable-unsafe-webgpu"] : []),
    ],
  });
}

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
    await sleep(200);
  }
}

const field = (page: Page, key: string): Promise<string> =>
  page.locator(`[data-field="${key}"]`).first().textContent({ timeout: 2000 }).then((t) => t ?? "", () => "");

interface Env {
  readonly crossOriginIsolated: boolean;
  readonly userAgent: string;
  readonly fallbackAdapter: string;
  readonly asrBackend: string;
  readonly asrDevice: string;
  readonly mtRuntime: string;
  readonly mtAdapter: string;
  readonly loadVad: string;
  readonly loadAsr: string;
  readonly loadMt: string;
}

/** Opens the app, downloads the models into OPFS the first time, and refuses an environment that would not be a fair run. */
async function boot(context: BrowserContext): Promise<{ page: Page; env: Env }> {
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(60_000);
  await page.goto(appUrl);
  if ((await waitForStatus(page, ["Setup needed", "Ready"], 10 * 60_000)) === "Setup needed") {
    await page.locator('[data-role="download"]').click();
    await waitForStatus(page, ["Ready"], 20 * 60_000);
  }
  const env: Env = {
    crossOriginIsolated: await page.evaluate(() => crossOriginIsolated),
    userAgent: await page.evaluate(() => navigator.userAgent),
    fallbackAdapter: await field(page, "fallback adapter"),
    asrBackend: await field(page, "asr-backend"),
    asrDevice: await field(page, "asr-device"),
    mtRuntime: await field(page, "mt-runtime"),
    mtAdapter: await field(page, "mt-adapter"),
    loadVad: await field(page, "load-vad"),
    loadAsr: await field(page, "load-asr"),
    loadMt: await field(page, "load-mt"),
  };
  if (!env.crossOriginIsolated) throw new Error("the page is not crossOriginIsolated");
  if (env.fallbackAdapter !== "false" || env.asrDevice.includes("fallback")) throw new Error(`not a real WebGPU adapter: ${JSON.stringify(env)}`);
  return { page, env };
}

const snapshot = (page: Page): Promise<SessionRecord> => page.evaluate(() => window.__mimivoxEval!.snapshot());

/** Presses Start on the fake microphone, lets the file play out, presses Stop and reads the rows. */
async function sessionOnMic(page: Page, seconds: number): Promise<SessionRecord> {
  const start = page.locator('[data-role="start"]');
  await start.click();
  await waitForStatus(page, ["Live"], 60_000);
  await sleep((seconds + 2.5) * 1000);
  await start.click();
  await waitForStatus(page, ["Ready"], 120_000);
  return snapshot(page);
}

/** Picks the WAV in the app's file source, presses Start, and lets the replay end the session by itself. */
async function sessionOnFile(page: Page, wav: string, seconds: number): Promise<SessionRecord> {
  await page.locator('[data-role="source"] label', { hasText: "WAV file" }).click();
  await page.locator('[data-role="file-input"]').setInputFiles(wav);
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-role="start"]')?.disabled);
  await page.locator('[data-role="start"]').click();
  await waitForStatus(page, ["Live"], 60_000);
  await waitForStatus(page, ["Ready"], (seconds + 90) * 1000);
  return snapshot(page);
}

interface Result extends SessionRecord {
  readonly seconds: number;
  readonly wallS: number;
  readonly error?: string;
}
const failed = (seconds: number, wallS: number, error: unknown): Result => ({
  rows: [],
  unsettled: 0,
  errors: [],
  maxBacklogS: 0,
  seconds,
  wallS,
  error: error instanceof Error ? error.message : String(error),
});

/** The page the file-source sessions share. A holder, so control-flow analysis does not pin it to its first value. */
const warm = { current: null as { context: BrowserContext; page: Page } | null };
let env: Env | null = null;
const consoleTail: string[] = [];

async function open(fakeMicWav: string | null): Promise<{ context: BrowserContext; page: Page }> {
  const context = await launch(fakeMicWav);
  const booted = await boot(context).catch(async (error: unknown) => {
    await context.close();
    throw error;
  });
  booted.page.on("console", (m) => consoleTail.push(`[${m.type()}] ${m.text()}`));
  booted.page.on("pageerror", (e) => consoleTail.push(`[pageerror] ${e.message}`));
  env ??= booted.env;
  return { context, page: booted.page };
}

/** One session, with a fresh Chrome and one retry if it fails; a second failure is recorded, not thrown. */
async function measure(via: Via, wav: string, seconds: number): Promise<Result> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    let own: { context: BrowserContext; page: Page } | null = null;
    try {
      if (via === "mic") {
        own = await open(wav);
        const record = await sessionOnMic(own.page, seconds);
        return { ...record, seconds, wallS: (Date.now() - started) / 1000 };
      }
      warm.current ??= await open(null);
      const record = await sessionOnFile(warm.current.page, wav, seconds);
      return { ...record, seconds, wallS: (Date.now() - started) / 1000 };
    } catch (error) {
      lastError = error;
      progress(`  attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
      progress(consoleTail.slice(-8).join("\n"));
      if (via === "file") {
        await warm.current?.context.close().catch(() => undefined);
        warm.current = null;
      }
    } finally {
      await own?.context.close().catch(() => undefined);
    }
  }
  return failed(seconds, 0, lastError);
}

const runClips: Record<string, unknown>[] = [];
const runMeetings: Record<string, unknown>[] = [];
const host = { platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "", memoryGb: Math.round(totalmem() / 2 ** 30) };
const write = (complete: boolean): void =>
  writeFileSync(
    outPath,
    JSON.stringify({
      complete,
      runtime: { kind: "web", realtime: true, clipsVia, meetingsVia, host, env, unsafeWebgpu: values["unsafe-webgpu"] },
      clips: runClips,
      meetings: runMeetings,
    }),
  );

let ok = true;
try {
  for (const [i, c] of clips.entries()) {
    const r = await measure(clipsVia, join(inputs, c.file), c.seconds);
    runClips.push({ sid: c.sid, ...r });
    progress(`clip ${i + 1}/${clips.length} ${c.sid}: ${r.error === undefined ? `${r.rows.length} rows` : "FAILED"} (${r.wallS.toFixed(1)} s)`);
    write(false);
  }
  // Two Chrome processes cannot share one profile: the warm page the clips used goes before the meetings' own launches.
  await warm.current?.context.close();
  warm.current = null;
  for (const m of meetings) {
    const r = await measure(meetingsVia, join(inputs, m.file), m.seconds);
    runMeetings.push({ name: m.name, ...r });
    progress(`meeting ${m.name}: ${r.error === undefined ? `${r.rows.length} rows, ${r.unsettled} unsettled` : "FAILED"} (${r.wallS.toFixed(1)} s)`);
    write(false);
  }
  ok = [...runClips, ...runMeetings].every((r) => r["error"] === undefined);
  write(ok);
} catch (error) {
  ok = false;
  console.error(error);
} finally {
  await warm.current?.context.close().catch(() => undefined);
  await vite.close();
  files.close();
}
progress(ok ? `rows written to ${outPath}` : "the run did not complete");
process.exit(ok ? 0 : 1);

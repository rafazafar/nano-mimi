// Drives bench/mt.html in the installed Google Chrome on real WebGPU.
//
//   node bench/mt.drive.mjs prime                      download the model into the bench profile's OPFS
//   node bench/mt.drive.mjs bench <data.json> <out.json>   load, warm up on 3 lines, translate every item
//   node bench/mt.drive.mjs cancel <out.json>          preview preempted by a final
//
// Timed modes belong under the GPU lock. The profile lives in $MT_BENCH_PROFILE
// (default: web/.bench-profile), so the 1 GB download happens once.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [mode, ...args] = process.argv.slice(2);
const web = path.resolve(import.meta.dirname, "..");
const profile = process.env.MT_BENCH_PROFILE ?? path.join(web, ".bench-profile");
const VITE_PORT = 5199;
const MODEL_PORT = 8790;

function serve(cmd, argv, ready) {
  const child = spawn(cmd, argv, { cwd: web, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (b) => {
      if (ready.test(b.toString())) resolve(child);
    });
    child.on("exit", (code) => reject(new Error(`${cmd} exited ${code}`)));
  });
}

const servers = [
  await serve("node", ["bench/mt.server.mjs", String(MODEL_PORT)], /serving/),
  await serve("npx", ["vite", "--port", String(VITE_PORT), "--strictPort"], /Local:/),
];
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: process.env.HEADED === undefined,
  args: ["--enable-unsafe-webgpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
});
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.error("[page]", m.type(), m.text().slice(0, 400));
  });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto(`http://localhost:${VITE_PORT}/bench/mt.html?endpoint=http://127.0.0.1:${MODEL_PORT}`);
  await page.waitForFunction(() => window.bench !== undefined, null, { timeout: 120_000 });
  const gpu = await page.evaluate(() => window.bench.gpu());
  console.log("gpu", JSON.stringify(gpu));
  if (gpu === null || gpu.isFallbackAdapter) throw new Error("no hardware WebGPU adapter");

  const download = await page.evaluate(() => window.bench.download());
  console.log("download", JSON.stringify(download));
  const load = mode === "prime" ? null : await page.evaluate(() => window.bench.start());
  if (load !== null) console.log("load", JSON.stringify(load));

  if (mode === "prime") {
    // Download only.
  } else if (mode === "bench") {
    const [dataPath, outPath] = args;
    const { items } = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    for (const it of items.slice(0, 3)) await page.evaluate((ja) => window.bench.translate(ja), it.ja);
    const rows = [];
    for (const it of items) {
      const run = await page.evaluate((ja) => window.bench.translate(ja), it.ja);
      if (run.outcome.kind !== "done") throw new Error(`${it.id}: ${run.outcome.kind}`);
      rows.push({ id: it.id, ja: it.ja, ref: it.ref, result: run.outcome.result, wallMs: run.wallMs, streamed: run.streamed });
      if (rows.length % 20 === 0) console.log(`${rows.length}/${items.length}`);
    }
    fs.writeFileSync(outPath, JSON.stringify({ gpu, load, rows }, null, 1));
    console.log("wrote", outPath);
  } else if (mode === "cancel") {
    const [outPath] = args;
    const longJa =
      "1789年10月6日、恐怖におびえた国王ルイ16世、王妃マリー・アントワネットと2人の幼い子供たち、" +
      "そして国王の妹エリザベート夫人は、市場の女性たちの暴徒によってヴェルサイユからパリへと強制的に戻されました。";
    const finalJa = "来週までに返事をしないといけないですね。";
    await page.evaluate((ja) => window.bench.translate(ja), finalJa); // warm up
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await page.evaluate(([p, f]) => window.bench.cancelTest(p, f), [longJa, finalJa]));
    for (const r of runs) console.log(JSON.stringify({ ...r, finalOutcome: r.finalOutcome.kind === "done" ? r.finalOutcome.result.en : r.finalOutcome.kind }));
    fs.writeFileSync(outPath, JSON.stringify({ gpu, load, runs }, null, 1));
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} finally {
  await ctx.close();
  for (const s of servers) s.kill();
}

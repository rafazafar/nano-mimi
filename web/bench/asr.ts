import { AsrClient } from "../src/asr/client";
import { asrModels, type ModelBackend } from "../src/asr/models";
import { ModelStore, OpfsBlobStore, type Manifest } from "../src/models";

export interface BenchConfig {
  /** Model-store endpoint serving `<repo>/resolve/<revision>/<path>`. */
  readonly endpoint: string;
  /** Base URL of `clips.json` and `audio/<sid>.f32`. */
  readonly clips: string;
  readonly backend: ModelBackend;
  readonly threads: number;
  readonly n: number;
  readonly passes: number;
  readonly warmup: number;
}

interface Clip {
  readonly sid: string;
  readonly ref: string;
  readonly dur_s: number;
}

export interface BenchRow {
  readonly sid: string;
  readonly text: string;
  readonly raw: string;
  readonly ids: readonly number[];
  /** Main thread round trip: postMessage to transcript. */
  readonly ms: number;
  readonly melMs: number;
  readonly encMs: number;
  readonly decMs: number;
  readonly steps: number;
}

const logEl = document.getElementById("log")!;
const log = (s: string): void => {
  logEl.textContent += `${s}\n`;
  console.log(`[bench] ${s}`);
};

const median = (a: readonly number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;

async function bench(cfg: BenchConfig): Promise<unknown> {
  const manifest: Manifest = { endpoint: cfg.endpoint, models: asrModels("ja-en", cfg.backend) };
  const t0 = performance.now();
  const store = new ModelStore({ manifest, store: new OpfsBlobStore() });
  await store.ensureAll();
  if (!store.allReady()) throw new Error("model download failed");
  const downloadMs = performance.now() - t0;
  log(`models ready in ${downloadMs.toFixed(0)} ms`);

  const asr = await AsrClient.create({ manifest, backend: cfg.backend, pair: "ja-en", threads: cfg.threads });
  log(`worker ready in ${asr.loadMs.toFixed(0)} ms: ${JSON.stringify(asr.device)}`);

  const clips = ((await (await fetch(`${cfg.clips}/clips.json`)).json()) as Clip[]).slice(0, cfg.n);
  const audio = new Map<string, Float32Array>();
  for (const c of clips) audio.set(c.sid, new Float32Array(await (await fetch(`${cfg.clips}/audio/${c.sid}.f32`)).arrayBuffer()));

  const run = async (c: Clip): Promise<BenchRow> => {
    const t = performance.now();
    const r = await asr.transcribeDetailed(audio.get(c.sid)!);
    const ms = performance.now() - t;
    return { sid: c.sid, text: r.text, raw: r.raw, ids: r.ids, ms, ...r.timing };
  };
  const cold = await run(clips[0]!);
  for (const c of clips.slice(1, cfg.warmup)) await run(c);
  const passes: BenchRow[][] = [];
  for (let p = 0; p < cfg.passes; p++) {
    const rows: BenchRow[] = [];
    for (const c of clips) rows.push(await run(c));
    const m = (k: "ms" | "melMs" | "encMs" | "decMs"): string => median(rows.map((r) => r[k])).toFixed(1);
    log(`pass ${p}: p50 ${m("ms")} ms (mel ${m("melMs")}, enc ${m("encMs")}, dec ${m("decMs")})`);
    passes.push(rows);
  }
  asr.terminate();
  return { device: asr.device, downloadMs, loadMs: asr.loadMs, cold, passes };
}

declare global {
  interface Window {
    asrBench?: (cfg: BenchConfig) => Promise<unknown>;
  }
}
window.asrBench = bench;

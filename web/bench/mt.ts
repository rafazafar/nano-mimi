import { asJaText } from "../src/core/types";
import { OpfsBlobStore } from "../src/models/blob-store";
import { CAT_MODEL } from "../src/models/manifest";
import { ModelStore } from "../src/models/model-store";
import type { Manifest } from "../src/models/types";
import { MtClient } from "../src/mt/client";
import type { MtOutcome } from "../src/mt/protocol";

const endpoint = new URLSearchParams(location.search).get("endpoint") ?? "http://127.0.0.1:8790";
const manifest: Manifest = { endpoint, models: [CAT_MODEL] };
let client: MtClient | null = null;

const log = (line: string): void => {
  document.getElementById("log")!.textContent += `${line}\n`;
};

function ready(): MtClient {
  if (client === null) throw new Error("call start() first");
  return client;
}

export interface TranslateRun {
  readonly outcome: MtOutcome;
  readonly wallMs: number;
  readonly streamed: string;
}

async function translate(ja: string, preview = false): Promise<TranslateRun> {
  const t0 = performance.now();
  let streamed = "";
  const run = ready().translate(asJaText(ja), [], { preview, onToken: (d) => (streamed += d) });
  const outcome = await run.outcome;
  return { outcome, wallMs: performance.now() - t0, streamed };
}

/**
 * Starts a long preview, waits until it has streamed `afterTokens` tokens, then
 * submits a final. Reports how long the preview took to stop and how many of its
 * tokens arrived after the final was issued.
 */
async function cancelTest(previewJa: string, finalJa: string, afterTokens = 5) {
  const c = ready();
  let previewTokens = 0;
  let tokensAfterIssue = 0;
  let issuedAt = 0;
  let reached!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  const preview = c.translate(asJaText(previewJa), [], {
    preview: true,
    onToken: () => {
      previewTokens++;
      if (issuedAt > 0) tokensAfterIssue++;
      if (previewTokens === afterTokens) reached();
    },
  });
  await reachedP;
  issuedAt = performance.now();
  const final = c.translate(asJaText(finalJa), [], { preview: false });
  const previewOutcome = await preview.outcome;
  const stoppedAt = performance.now();
  const finalOutcome = await final.outcome;
  const finishedAt = performance.now();
  return {
    previewOutcome: previewOutcome.kind,
    previewTokensBeforeIssue: previewTokens - tokensAfterIssue,
    previewTokensAfterIssue: tokensAfterIssue,
    cancelLatencyMs: stoppedAt - issuedAt,
    finalOutcome,
    finalWallMs: finishedAt - issuedAt,
  };
}

const bench = {
  async gpu() {
    const a = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (a === null || a === undefined) return null;
    const info = a.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
    return {
      vendor: info.vendor,
      architecture: info.architecture,
      description: info.description,
      isFallbackAdapter: info.isFallbackAdapter ?? false,
      shaderF16: a.features.has("shader-f16"),
      crossOriginIsolated,
    };
  },
  /** Downloads (or confirms) the CAT files into OPFS through the model store. */
  async download() {
    const t0 = performance.now();
    const store = new ModelStore({ manifest, store: new OpfsBlobStore(), storage: navigator.storage });
    await store.ensureAll();
    if (!store.allReady()) {
      const states = CAT_MODEL.files.map((f) => [f.path, store.state({ modelId: CAT_MODEL.id, path: f.path })]);
      throw new Error(`download incomplete: ${JSON.stringify(states)}`);
    }
    log(`model files ready in ${(performance.now() - t0).toFixed(0)} ms`);
    return { ms: performance.now() - t0 };
  },
  async start() {
    client?.terminate();
    const t0 = performance.now();
    client = await MtClient.start(manifest, CAT_MODEL.id, "ja-en");
    log(`worker ready: ${JSON.stringify(client.load)}`);
    return { ...client.load, wallMs: performance.now() - t0 };
  },
  translate,
  cancelTest,
};

declare global {
  interface Window {
    bench: typeof bench;
  }
}
window.bench = bench;
log("bench loaded");

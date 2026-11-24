import {
  AutoModelForCausalLM,
  AutoTokenizer,
  BaseStreamer,
  LogitsProcessor,
  StoppingCriteria,
  Tensor,
  env,
  type PreTrainedModel,
} from "@huggingface/transformers";
import { OpfsBlobStore } from "../models/blob-store";
import { ModelStore } from "../models/model-store";
import type { Manifest, ModelSpec } from "../models/types";
import type { Generate } from "./ladder";
import type { AdapterInfo, LoadInfo } from "./protocol";
import { CatTokenizer, type TjsTokenizer } from "./tokenizer";

/**
 * transformers.js fetches model files from this host; `storeFetch` answers from
 * OPFS. Its own Cache API write fails on the 1 GB weights file, so its caches are off.
 */
const STORE_HOST = "https://model-store.invalid/";

// The ORT build transformers.js bundles must load its own wasm, not the CDN copy it defaults to.
const ORT_DIST = "../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/";
const WASM_PATHS = {
  mjs: new URL(`${ORT_DIST}ort-wasm-simd-threaded.asyncify.mjs`, import.meta.url).href,
  wasm: new URL(`${ORT_DIST}ort-wasm-simd-threaded.asyncify.wasm`, import.meta.url).href,
};

function storeFetch(store: ModelStore, model: ModelSpec): typeof fetch {
  const prefix = `${STORE_HOST}${model.repo}/resolve/${model.revision}/`;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(prefix)) return fetch(input, init);
    const path = decodeURIComponent(url.slice(prefix.length));
    // Optional files transformers.js probes for (processor configs and the like).
    if (!model.files.some((f) => f.path === path)) return new Response(null, { status: 404 });
    const blob = await store.getBlob(model.id, path);
    return new Response(blob, { status: 200, headers: { "Content-Length": String(blob.size) } });
  };
}

async function adapterInfo(): Promise<AdapterInfo | null> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (adapter === null || adapter === undefined) return null;
  const info = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
  return {
    vendor: info.vendor,
    architecture: info.architecture,
    description: info.description,
    isFallbackAdapter: info.isFallbackAdapter ?? false,
    shaderF16: adapter.features.has("shader-f16"),
  };
}

/** Sets Japanese-script logits to -inf, as translate.py's `ban_japanese`. */
class BanTokens extends LogitsProcessor {
  constructor(private readonly ids: Int32Array) {
    super();
  }
  override _call(_inputIds: bigint[][], logits: Tensor): Tensor {
    const data = logits.data;
    if (!(data instanceof Float32Array)) throw new Error(`unexpected logits type ${data.constructor.name}`);
    const vocab = logits.dims.at(-1)!;
    for (let row = 0; row < data.length; row += vocab) for (const id of this.ids) data[row + id] = -Infinity;
    return logits;
  }
}

/** Ends generation at the next step once the job is aborted. */
class StopOnAbort extends StoppingCriteria {
  constructor(private readonly signal: AbortSignal) {
    super();
  }
  override _call(inputIds: number[][]): boolean[] {
    return inputIds.map(() => this.signal.aborted);
  }
}

/** Collects generated ids with their times and streams the text as it grows. */
class TokenStream extends BaseStreamer {
  readonly ids: number[] = [];
  readonly stamps: number[] = [];
  private promptSeen = false;
  private text = "";

  constructor(
    private readonly tok: CatTokenizer,
    private readonly onToken: ((delta: string) => void) | null,
  ) {
    super();
  }

  override put(value: bigint[][]): void {
    if (!this.promptSeen) {
      this.promptSeen = true;
      return;
    }
    const id = Number(value[0]![0]!);
    if (id === this.tok.eosTokenId) return;
    this.ids.push(id);
    this.stamps.push(performance.now());
    if (this.onToken === null) return;
    const text = this.tok.decode(this.ids);
    // Hold back a partial UTF-8 sequence until its last byte piece arrives.
    if (text.endsWith("�") || !text.startsWith(this.text)) return;
    const delta = text.slice(this.text.length);
    this.text = text;
    if (delta !== "") this.onToken(delta);
  }

  override end(): void {}
}

export class CatEngine {
  private constructor(
    private readonly tok: CatTokenizer,
    private readonly model: PreTrainedModel,
    private readonly ban: BanTokens,
    readonly load: LoadInfo,
  ) {}

  /** Loads CAT from files the model store has already downloaded and verified. */
  static async load(manifest: Manifest, modelId: string): Promise<CatEngine> {
    const model = manifest.models.find((m) => m.id === modelId);
    if (model === undefined) throw new Error(`${modelId} is not in the manifest`);
    const store = new ModelStore({ manifest: { ...manifest, models: [model] }, store: new OpfsBlobStore() });
    await store.refresh();
    if (!store.allReady()) throw new Error(`${model.label} is not downloaded yet`);

    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.remoteHost = STORE_HOST;
    env.useBrowserCache = false;
    env.useWasmCache = false;
    env.fetch = storeFetch(store, model);
    const onnx = env.backends.onnx;
    if (onnx.wasm !== undefined) onnx.wasm.wasmPaths = WASM_PATHS;

    const adapter = await adapterInfo();
    const t0 = performance.now();
    const raw = (await AutoTokenizer.from_pretrained(model.repo, { revision: model.revision })) as unknown as TjsTokenizer;
    const config = JSON.parse(await (await store.getBlob(model.id, "generation_config.json")).text()) as { eos_token_id?: number };
    const tok = new CatTokenizer(raw, config.eos_token_id ?? null);
    const t1 = performance.now();
    const lm = await AutoModelForCausalLM.from_pretrained(model.repo, {
      revision: model.revision,
      device: "webgpu",
      dtype: "q4f16",
    });
    const t2 = performance.now();
    return new CatEngine(tok, lm, new BanTokens(tok.bannedIds), {
      tokenizerMs: t1 - t0,
      modelMs: t2 - t1,
      adapter,
      runtime: `transformers.js ${env.version}`,
    });
  }

  readonly generate: Generate = async (request, onToken, signal) => {
    signal.throwIfAborted();
    const t0 = performance.now();
    const ids = this.tok.encode(this.tok.render(request.messages));
    const stream = new TokenStream(this.tok, onToken);
    // generate() takes a plain processor array at runtime (it extends its own list with it), and
    // any BaseStreamer; the published types ask for a LogitsProcessorList and a TextStreamer.
    type GenerateParams = Parameters<PreTrainedModel["generate"]>[0];
    await this.model.generate({
      input_ids: new Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
      attention_mask: new Tensor("int64", new BigInt64Array(ids.length).fill(1n), [1, ids.length]),
      max_new_tokens: request.maxTokens,
      do_sample: false,
      logits_processor: [this.ban] as unknown as NonNullable<GenerateParams["logits_processor"]>,
      stopping_criteria: [new StopOnAbort(signal)],
      streamer: stream as unknown as NonNullable<GenerateParams["streamer"]>,
    });
    signal.throwIfAborted();
    const s = stream.stamps;
    const first = s[0];
    const last = s.at(-1);
    return {
      raw: this.tok.decode(stream.ids),
      tokens: stream.ids.length,
      ms: performance.now() - t0,
      ttftMs: first === undefined ? null : first - t0,
      decodeTps: first !== undefined && last !== undefined && s.length > 2 ? ((s.length - 1) * 1000) / (last - first) : null,
    };
  };
}

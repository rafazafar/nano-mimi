/** The fields of Haas-ja's `config.json` that the browser front end and decoder read. */
export interface HaasConfig {
  readonly sampleRate: number;
  readonly nFft: number;
  readonly winLength: number;
  readonly hopLength: number;
  readonly nMels: number;
  readonly padTo: number;
  readonly dModel: number;
  readonly predLayers: number;
  readonly vocabSize: number;
  readonly durations: readonly number[];
  readonly maxSymbols: number;
  /** Width of each decoder state row: `kda_state_width` in haas_ja_local's config. */
  readonly stateWidth: number;
}

function int(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`config.${k} must be a non-negative integer`);
  return v;
}

/** Parses the untrusted `config.json` bytes into a HaasConfig. */
export function parseHaasConfig(raw: unknown): HaasConfig {
  if (typeof raw !== "object" || raw === null) throw new Error("config must be an object");
  const o = raw as Record<string, unknown>;
  const durations = o["durations"];
  if (!Array.isArray(durations) || !durations.every((d) => Number.isInteger(d) && d >= 0)) {
    throw new Error("config.durations must be an array of non-negative integers");
  }
  const valueDim = int(o, "kda_heads") * int(o, "kda_head_dim");
  return {
    sampleRate: int(o, "sample_rate"),
    nFft: int(o, "n_fft"),
    winLength: int(o, "win_length"),
    hopLength: int(o, "hop_length"),
    nMels: int(o, "n_mels"),
    padTo: int(o, "pad_to"),
    dModel: int(o, "d_model"),
    predLayers: int(o, "pred_layers"),
    vocabSize: int(o, "vocab_size"),
    durations: durations as number[],
    maxSymbols: int(o, "max_symbols"),
    stateWidth: Math.max(valueDim * int(o, "kda_head_dim"), 3 * valueDim * int(o, "kda_conv_size")),
  };
}

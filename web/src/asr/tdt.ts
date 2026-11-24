import type { HaasConfig } from "./config";

/**
 * One prediction-network + joint evaluation: feed `token` from `state`, join with encoder
 * frame `t`. Returns logits laid out `[vocab+1 token logits, durations.length duration
 * logits]` and the state after consuming `token`.
 */
export interface Joint<S> {
  initState(): S;
  step(t: number, token: number, state: S): Promise<{ readonly logits: Float32Array; readonly state: S }>;
}

function argmax(a: Float32Array, from: number, to: number): number {
  let best = from;
  for (let i = from + 1; i < to; i++) if (a[i]! > a[best]!) best = i;
  return best - from;
}

/** Token ids and joint evaluations from NeMo's TDT greedy rule, a port of haas_ja_local `decode.greedy_tdt`. */
export async function greedyTdt<S>(joint: Joint<S>, frames: number, cfg: HaasConfig): Promise<{ ids: number[]; steps: number }> {
  const nVocab = cfg.vocabSize + 1;
  const blank = cfg.vocabSize;
  const nDur = cfg.durations.length;
  let state = joint.initState();
  let last = blank;
  let symbols = 0;
  let t = 0;
  let steps = 0;
  const ids: number[] = [];
  while (t < frames) {
    const out = await joint.step(t, last, state);
    steps++;
    const k = argmax(out.logits, 0, nVocab);
    const d = cfg.durations[argmax(out.logits, nVocab, nVocab + nDur)]!;
    if (k === blank) {
      t += Math.max(d, 1);
      symbols = 0;
      continue;
    }
    ids.push(k);
    last = k;
    state = out.state;
    t += d;
    if (d === 0) {
      if (++symbols >= cfg.maxSymbols) {
        t += 1;
        symbols = 0;
      }
    } else {
      symbols = 0;
    }
  }
  return { ids, steps };
}

import { AsrClient } from "../asr/client";
import type { AsrDevice } from "../asr/protocol";
import type { AsrBackend } from "../asr/models";
import { loadSilero } from "../audio/sileroBrowser";
import type { WindowScorer } from "../audio/streamingVad";
import { CAT_MODEL } from "../models/manifest";
import type { Manifest } from "../models/types";
import { MtClient } from "../mt/client";
import type { LoadInfo } from "../mt/protocol";
import type { PairId } from "../core/pair";
import { prepareSpeech, prepareTranslator } from "./builtin";
import type { AsrEngine, MtEngine } from "./types";

export type EnginePhase = "vad" | "asr" | "mt";

export interface EngineInfo {
  /** Null when Chrome's own recognizer runs. */
  readonly asr: AsrDevice | null;
  readonly asrLoadMs: number;
  readonly mt: LoadInfo;
  readonly mtLoadMs: number;
  readonly vadLoadMs: number;
  /** Silero, ASR and CAT from OPFS to ready, one after the other. */
  readonly totalLoadMs: number;
}

export interface Engines {
  /** The direction these engines were loaded for: the recognizer is the source language's. */
  readonly pair: PairId;
  readonly recognition: Recognition;
  readonly mt: MtEngine;
  readonly info: EngineInfo;
  /** Terminates both workers and frees their GPU memory. */
  dispose(): void;
}

/** Our VAD and recognizer, or Chrome's recognizer, which finds utterances itself and listens to the track. */
export type Recognition =
  | { readonly kind: "model"; readonly asr: AsrEngine; readonly scorer: WindowScorer }
  | { readonly kind: "browser"; readonly lang: string };

export function asrThreads(): number {
  if (!crossOriginIsolated) return 1;
  return Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2));
}

/**
 * Loads Silero, the pair's ASR worker (Haas-ja or Parakeet-EN) and the CAT worker from the model store, sequentially so the two
 * GPU models do not compile their kernels against each other. Every file in `manifest` must already be
 * downloaded and verified.
 */
export async function loadEngines(
  manifest: Manifest,
  backend: AsrBackend,
  pair: PairId,
  onPhase: (phase: EnginePhase, state: "start" | "done") => void = () => undefined,
): Promise<Engines> {
  const t0 = performance.now();
  const timed = async <T>(phase: EnginePhase, load: () => Promise<T>): Promise<[T, number]> => {
    onPhase(phase, "start");
    const start = performance.now();
    const value = await load();
    onPhase(phase, "done");
    return [value, performance.now() - start];
  };
  if (backend === "browser") return loadBrowserEngines(pair, timed, t0);
  const [scorer, vadLoadMs] = await timed("vad", loadSilero);
  const [asr, asrLoadMs] = await timed("asr", () => AsrClient.create({ manifest, backend, pair, threads: asrThreads() }));
  let mt: MtClient;
  let mtLoadMs: number;
  try {
    [mt, mtLoadMs] = await timed("mt", () => MtClient.start(manifest, CAT_MODEL.id, pair));
  } catch (error) {
    asr.terminate();
    throw error;
  }
  return {
    pair,
    recognition: { kind: "model", asr: { transcribe: (samples) => asr.transcribe(samples) }, scorer },
    mt,
    info: { asr: asr.device, asrLoadMs, mt: mt.load, mtLoadMs, vadLoadMs, totalLoadMs: performance.now() - t0 },
    dispose() {
      asr.terminate();
      mt.terminate();
    },
  };
}

type Timed = <T>(phase: EnginePhase, load: () => Promise<T>) => Promise<[T, number]>;

/** Chrome's on-device recognizer and translator: nothing of ours to download, Chrome installs its own packs. */
async function loadBrowserEngines(pair: PairId, timed: Timed, t0: number): Promise<Engines> {
  const [, vadLoadMs] = await timed("vad", async () => undefined);
  const [lang, asrLoadMs] = await timed("asr", () => prepareSpeech(pair));
  const [mt, mtLoadMs] = await timed("mt", () => prepareTranslator(pair));
  return {
    pair,
    recognition: { kind: "browser", lang },
    mt,
    info: {
      asr: null,
      asrLoadMs,
      mt: { tokenizerMs: 0, modelMs: mtLoadMs, adapter: null, runtime: "Chrome Translator (on device)" },
      mtLoadMs,
      vadLoadMs,
      totalLoadMs: performance.now() - t0,
    },
    dispose: () => mt.destroy(),
  };
}

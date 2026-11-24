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
import type { AsrEngine, MtEngine } from "./types";

export type EnginePhase = "vad" | "asr" | "mt";

export interface EngineInfo {
  readonly asr: AsrDevice;
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
  readonly asr: AsrEngine;
  readonly mt: MtEngine;
  readonly scorer: WindowScorer;
  readonly info: EngineInfo;
  /** Terminates both workers and frees their GPU memory. */
  dispose(): void;
}

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
    asr: {
      transcribe: (samples) => asr.transcribe(samples),
    },
    mt,
    scorer,
    info: { asr: asr.device, asrLoadMs, mt: mt.load, mtLoadMs, vadLoadMs, totalLoadMs: performance.now() - t0 },
    dispose() {
      asr.terminate();
      mt.terminate();
    },
  };
}

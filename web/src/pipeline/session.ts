import { StreamingVad } from "../audio/streamingVad";
import { LIVE_TUNING } from "../audio/vadStateMachine";
import type { Glossary } from "../core/glossary";
import type { Engines } from "./engines";
import { UtteranceFeed } from "./feed";
import { Pipeline } from "./pipeline";
import { openSource } from "./sources";
import { LIVE_OPTIONS, performanceClock, REPLAY_OPTIONS, type PipelineEvent, type PipelineOptions } from "./types";

/** Where the audio comes from. A file is replayed at 1x through the same capture path as the others. */
export type SourceSpec =
  | { readonly kind: "mic" }
  | { readonly kind: "tab" }
  | { readonly kind: "file"; readonly name: string; readonly bytes: Uint8Array };

export interface SessionOptions {
  readonly engines: Engines;
  readonly source: SourceSpec;
  /** Read at every translation, so edits to the glossary apply to the next line. */
  readonly glossary: () => Glossary;
  readonly onEvent: (event: PipelineEvent) => void;
  /** Defaults to the replay policy for a file and the live policy otherwise. */
  readonly pipeline?: PipelineOptions;
}

export interface Session {
  readonly sourceLabel: string;
  audioSeconds(): number;
  /** Stops capture, closes the open utterance, lets queued speech finish, then resolves. */
  stop(): Promise<void>;
  /**
   * Settles when the session ends without `stop()`, after everything queued is on screen: a file played to
   * its end or a shared tab stopped sharing (resolves), or the microphone went away (rejects).
   */
  readonly ended: Promise<void>;
}

/**
 * Opens the source, then runs capture, the VAD and a fresh pipeline over it. Every session starts with an
 * empty translation cache and context. Rejects with the browser's own error when the source is refused.
 */
export async function startSession(options: SessionOptions): Promise<Session> {
  const { engines, source: spec, glossary, onEvent } = options;
  const source = await openSource(spec);
  const pipeline = new Pipeline({
    asr: engines.asr,
    mt: engines.mt,
    clock: performanceClock,
    glossary,
    pair: engines.pair,
    options: options.pipeline ?? (spec.kind === "file" ? REPLAY_OPTIONS : LIVE_OPTIONS),
  });
  pipeline.subscribe(onEvent);
  engines.scorer.reset();
  const feed = new UtteranceFeed(new StreamingVad(LIVE_TUNING, engines.scorer), pipeline, (detail) => pipeline.reportError(detail));

  try {
    await source.start((samples) => feed.feed(samples));
  } catch (error) {
    await pipeline.finish();
    throw error;
  }

  let finishing: Promise<void> | null = null;
  const finish = (): Promise<void> =>
    (finishing ??= (async () => {
      await source.stop();
      await feed.close();
      await pipeline.finish();
    })());

  return {
    sourceLabel: source.label,
    audioSeconds: () => feed.audioSeconds,
    stop: finish,
    ended: source.ended.then(finish, async (error: unknown) => {
      await finish();
      throw error;
    }),
  };
}

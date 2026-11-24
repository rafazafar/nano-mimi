import { emitted, type StreamingVad } from "../audio/streamingVad";
import { SAMPLE_RATE, type Candidate } from "../audio/vadStateMachine";
import type { AsrItem } from "./types";

export interface UtteranceSink {
  submit(item: Omit<AsrItem, "enqueuedAtMs">): Promise<void>;
  advanceAudio(seconds: number): void;
}

/**
 * Capture blocks in, utterances out. It runs the VAD over the stream and hands each utterance that survives
 * the post-emit rules to the pipeline, in order. The audio clock moves the moment samples arrive, not when
 * the VAD has scored them, so the backlog figure never lags the stream.
 */
export class UtteranceFeed {
  readonly #vad: StreamingVad;
  readonly #sink: UtteranceSink;
  readonly #onError: (detail: string) => void;
  #fedSamples = 0;
  #chain: Promise<void> = Promise.resolve();

  constructor(vad: StreamingVad, sink: UtteranceSink, onError: (detail: string) => void) {
    this.#vad = vad;
    this.#sink = sink;
    this.#onError = onError;
  }

  get audioSeconds(): number {
    return this.#fedSamples / SAMPLE_RATE;
  }

  feed(samples: Float32Array): void {
    this.#fedSamples += samples.length;
    this.#sink.advanceAudio(this.audioSeconds);
    this.#step(() => this.#vad.feed(samples));
  }

  /** The stream is over: close the open utterance and wait until every utterance has been handed on. */
  async close(): Promise<void> {
    this.#step(() => this.#vad.flush());
    await this.#chain;
  }

  #step(run: () => Promise<readonly Candidate[]>): void {
    this.#chain = this.#chain.then(async () => {
      try {
        for (const u of emitted(await run())) {
          await this.#sink.submit({ samples: u.samples, audioEndS: u.end / SAMPLE_RATE, vadWaitS: u.vadWaitS });
        }
      } catch (error) {
        this.#onError(`Voice detection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
}

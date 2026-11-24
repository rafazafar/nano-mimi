import { VadStateMachine, WINDOW, type Candidate, type VadTuning } from "./vadStateMachine";

/** Scores 512-sample windows with P(speech). It carries the model's recurrent state between calls. */
export interface WindowScorer {
  score(win: Float32Array): Promise<number>;
  reset(): void;
}

/** A candidate that passed the post-emit rules and has audio to transcribe. */
export type Utterance = Candidate & { readonly samples: Float32Array };

export function emitted(candidates: readonly Candidate[]): Utterance[] {
  return candidates.filter((c): c is Utterance => c.samples !== null);
}

/**
 * Cuts a 16 kHz mono stream into windows, scores each exactly once and runs the
 * state machine. Any slicing of the same samples gives the same candidates.
 */
export class StreamingVad {
  readonly #scorer: WindowScorer;
  readonly #machine: VadStateMachine;
  #tail = new Float32Array(0);
  #queue: Promise<unknown> = Promise.resolve();

  constructor(tuning: VadTuning, scorer: WindowScorer) {
    this.#scorer = scorer;
    this.#machine = new VadStateMachine(tuning);
  }

  /** Calls may overlap; they run in order. */
  feed(samples: Float32Array): Promise<Candidate[]> {
    return this.#enqueue(() => this.#feed(samples));
  }

  /** Closes the open utterance at end of stream. A partial trailing window is dropped, as in Python. */
  flush(): Promise<Candidate[]> {
    return this.#enqueue(async () => {
      const result = this.#machine.flush();
      if (result.resetScorer) this.#scorer.reset();
      return [...result.candidates];
    });
  }

  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(job);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #feed(samples: Float32Array): Promise<Candidate[]> {
    const buf = new Float32Array(this.#tail.length + samples.length);
    buf.set(this.#tail, 0);
    buf.set(samples, this.#tail.length);
    const full = Math.floor(buf.length / WINDOW) * WINDOW;
    this.#tail = buf.slice(full);

    const out: Candidate[] = [];
    for (let at = 0; at < full; at += WINDOW) {
      const win = buf.subarray(at, at + WINDOW);
      const result = this.#machine.push(win, await this.#scorer.score(win));
      if (result.resetScorer) this.#scorer.reset();
      out.push(...result.candidates);
    }
    return out;
  }
}

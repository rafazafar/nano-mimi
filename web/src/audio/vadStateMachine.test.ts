import { describe, expect, it } from "vitest";
import { readFixture } from "../test/fixtures";
import { StreamingVad, emitted, type WindowScorer } from "./streamingVad";
import { EN_LIVE_TUNING, LIVE_TUNING, WINDOW, type Candidate, type VadTuning } from "./vadStateMachine";

type Segment = readonly [windows: number, prob: number, amplitude: number];

interface ScriptedCase {
  readonly name: string;
  readonly input: { readonly script: readonly Segment[] };
  readonly output: {
    readonly utterances: readonly {
      readonly start: number;
      readonly end: number;
      readonly emitted: boolean;
      readonly emitted_samples: number;
    }[];
    readonly vad_wait_s: readonly number[];
  };
}

interface ScriptedFile {
  readonly tuning: Record<string, number>;
  readonly cases: readonly ScriptedCase[];
}

const SLICE_SIZES = [1, 7, 512, 4096];

class ScriptedScorer implements WindowScorer {
  #next = 0;
  constructor(private readonly probs: readonly number[]) {}
  score(): Promise<number> {
    return Promise.resolve(this.probs[this.#next++] ?? 0);
  }
  reset(): void {}
}

function scriptAudio(script: readonly Segment[]): { audio: Float32Array; probs: number[] } {
  const total = script.reduce((n, [windows]) => n + windows * WINDOW, 0);
  const audio = new Float32Array(total);
  const probs: number[] = [];
  let at = 0;
  for (const [windows, prob, amplitude] of script) {
    audio.fill(amplitude, at, at + windows * WINDOW);
    at += windows * WINDOW;
    for (let i = 0; i < windows; i++) probs.push(prob);
  }
  return { audio, probs };
}

async function run(
  audio: Float32Array,
  probs: readonly number[],
  slice: number,
  tuning: VadTuning = LIVE_TUNING,
): Promise<{ candidates: Candidate[]; waits: number[] }> {
  const vad = new StreamingVad(tuning, new ScriptedScorer(probs));
  const candidates: Candidate[] = [];
  const waits: number[] = [];
  for (let i = 0; i < audio.length; i += slice) {
    const fed = await vad.feed(audio.subarray(i, i + slice));
    candidates.push(...fed);
    waits.push(...emitted(fed).map((u) => Math.round(u.vadWaitS * 1e6) / 1e6));
  }
  candidates.push(...(await vad.flush()));
  return { candidates, waits };
}

function summarize(candidates: readonly Candidate[]): ScriptedCase["output"]["utterances"] {
  return candidates.map((c) => ({
    start: c.start,
    end: c.end,
    emitted: c.samples !== null,
    emitted_samples: c.samples?.length ?? 0,
  }));
}

const scripted = readFixture<ScriptedFile>("vad/scripted.json");

describe("scripted VAD cases recorded from the Python state machine", () => {
  it("uses the tuning the fixtures were exported with", () => {
    expect(scripted.tuning).toEqual({
      threshold: LIVE_TUNING.threshold,
      min_silence_ms: LIVE_TUNING.minSilenceMs,
      speech_pad_ms: LIVE_TUNING.speechPadMs,
      min_speech_ms: LIVE_TUNING.minSpeechMs,
      min_speech_s: LIVE_TUNING.minSpeechS,
      max_emit_s: LIVE_TUNING.maxEmitS,
    });
  });

  for (const c of scripted.cases) {
    it(`${c.name}, identical for every feed slicing`, async () => {
      const { audio, probs } = scriptAudio(c.input.script);
      for (const slice of SLICE_SIZES) {
        const { candidates, waits } = await run(audio, probs, slice);
        expect(summarize(candidates), `slice ${slice}`).toEqual(c.output.utterances);
        expect(waits, `slice ${slice}`).toEqual(c.output.vad_wait_s);
      }
    });
  }
});

describe("the English tuning", () => {
  // 4 s of speech, a 192 ms breath, then 2 s more.
  const { audio, probs } = scriptAudio([
    [125, 0.9, 0.2],
    [6, 0.05, 0.0005],
    [62, 0.9, 0.2],
    [20, 0.05, 0.0005],
  ]);
  const lengths = async (tuning: VadTuning) => (await run(audio, probs, 4096, tuning)).candidates.filter((c) => c.samples !== null).map((c) => c.end - c.start);

  it("ends a line on a short breath once it has run 3 s; the Japanese tuning does not", async () => {
    expect(await lengths(EN_LIVE_TUNING)).toHaveLength(2);
    expect(await lengths(LIVE_TUNING)).toHaveLength(1);
  });
});

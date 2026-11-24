import { describe, expect, it } from "vitest";
import { asJaText } from "../core/types";
import { cleanAsrText, Pipeline } from "./pipeline";
import { FakeAsr, FakeClock, FakeMt, kinds, settle } from "./testing";
import { LIVE_OPTIONS, REPLAY_OPTIONS, type AsrItem, type PipelineEvent, type PipelineOptions } from "./types";

const SPEECH = ["見積もりが届きました。", "来週までに返事が必要です。", "部長に報告しておきます。", "資料は私が準備します。"];

/** An utterance of `seconds` of audio, whose first sample says which line it is, so the fake ASR can answer. */
function utterance(tag: number, over: { seconds?: number; audioEndS?: number } = {}): Omit<AsrItem, "enqueuedAtMs"> {
  const samples = new Float32Array(Math.round((over.seconds ?? 1) * 16_000));
  samples[0] = tag;
  return { samples, audioEndS: over.audioEndS ?? tag * 3, vadWaitS: 0.384 };
}

function rig(options: PipelineOptions = REPLAY_OPTIONS) {
  const clock = new FakeClock();
  const asr = new FakeAsr();
  const mt = new FakeMt();
  const pipeline = new Pipeline({ asr, mt, clock, glossary: () => new Map(), options });
  const events: PipelineEvent[] = [];
  pipeline.subscribe((e) => events.push(e));
  const finals = () => events.filter((e): e is Extract<PipelineEvent, { kind: "final" }> => e.kind === "final");
  return { clock, asr, mt, pipeline, events, finals };
}

/** The fake ASR answers each utterance with the line its first sample names. */
const speaks = (asr: FakeAsr): void => {
  asr.auto = (call) => SPEECH[(call.samples[0] ?? 0) - 1] ?? "";
};

describe("replaying a recording", () => {
  it("captions every utterance, in order, with the line each one said", async () => {
    const r = rig();
    speaks(r.asr);
    r.mt.auto = (call) => `EN<${call.ja}>`;
    for (const tag of [1, 2, 3, 4]) await r.pipeline.submit(utterance(tag));
    await r.pipeline.finish();

    expect(r.finals().map((f) => [f.id, f.ja])).toEqual(SPEECH.map((ja, i) => [i + 1, ja]));
    expect(r.finals().every((f) => f.en !== "")).toBe(true);
  });

  it("places each caption on the audio timeline from the end of its audio", async () => {
    const r = rig();
    speaks(r.asr);
    r.mt.auto = () => "Yes.";
    await r.pipeline.submit(utterance(1, { seconds: 2.5, audioEndS: 6 }));
    await r.pipeline.finish();
    expect(r.finals()[0]).toMatchObject({ timelineS: 3.5, durationS: 2.5 });
  });

  it("repairs a sentence the VAD cut in two, in place", async () => {
    const r = rig();
    r.asr.auto = (call) => (call.samples[0] === 1 ? "部長には報告しましたが、" : "まだ返事がありません。");
    r.mt.auto = (call) => `EN<${call.ja}>`;
    await r.pipeline.submit(utterance(1, { seconds: 1, audioEndS: 2 }));
    await r.pipeline.submit(utterance(2, { seconds: 1, audioEndS: 3.5 }));
    await r.pipeline.finish();

    expect(kinds(r.events).filter((k) => k === "final" || k === "revision")).toEqual(["final", "revision"]);
    const revision = r.events.find((e) => e.kind === "revision");
    expect(revision).toMatchObject({ targetId: 1, ja: "部長には報告しましたが、まだ返事がありません。" });
  });
});

describe("the GPU is shared", () => {
  it("queues a final's translation ahead of the next decode, and runs the decode when the translation is done", async () => {
    const r = rig();
    speaks(r.asr);
    for (const tag of [1, 2, 3]) await r.pipeline.submit(utterance(tag));
    await settle();
    expect([r.asr.calls.length, r.mt.calls.length]).toEqual([1, 1]);

    await settle();
    expect(r.asr.calls).toHaveLength(1);

    r.mt.calls[0]?.finish("one");
    await settle();
    // Decode 2 ran and its final took the GPU before decode 3.
    expect([r.asr.calls.length, r.mt.calls.length]).toEqual([2, 2]);

    r.mt.calls[1]?.finish("two");
    await settle();
    expect(r.asr.calls).toHaveLength(3);
  });

  it("starts no preview while a decode holds the GPU, though the partial text is shown", async () => {
    const r = rig(LIVE_OPTIONS);
    await r.pipeline.submit(utterance(1));
    await settle();
    r.asr.calls[0]?.segment("来週までに返事をします。");
    await settle();
    expect(r.events.some((e) => e.kind === "partial_ja")).toBe(true);
    expect(r.mt.calls).toEqual([]);
  });
});

describe("the live queue", () => {
  it("merges the utterances that pile up behind a busy decode into one", async () => {
    const r = rig(LIVE_OPTIONS);
    r.mt.auto = () => "A quote arrived.";
    await r.pipeline.submit(utterance(1));
    await settle();
    await r.pipeline.submit(utterance(2));
    await r.pipeline.submit(utterance(3));
    expect(r.asr.calls).toHaveLength(1);

    r.asr.calls[0]?.finish("見積もりが届きました。");
    await settle();
    expect(r.asr.calls).toHaveLength(2);
    expect(r.asr.calls[1]?.samples).toHaveLength(32_000);
  });
});

describe("text that is not a caption", () => {
  it("drops punctuation-only ASR output and goes on to the next utterance", async () => {
    const r = rig();
    r.asr.auto = (call) => (call.samples[0] === 1 ? "。。。" : "来週までに返事が必要です。");
    r.mt.auto = () => "Reply by next week.";
    await r.pipeline.submit(utterance(1));
    await r.pipeline.submit(utterance(2));
    await r.pipeline.finish();
    expect(r.finals().map((f) => f.id)).toEqual([1]);
  });

  it("cleans a decode loop and drops what is left of nothing", () => {
    expect(cleanAsrText(asJaText(""))).toBeNull();
    expect(cleanAsrText(asJaText("、。！"))).toBeNull();
    expect(cleanAsrText(asJaText("あいうえお".repeat(20)))).toBeNull();
    expect(cleanAsrText(asJaText("見積もりが届きました。"))).toBe("見積もりが届きました。");
  });
});

describe("failure", () => {
  it("reports an ASR error and keeps decoding", async () => {
    const r = rig();
    r.asr.auto = (call) => {
      if (call.samples[0] === 1) throw new Error("device lost");
      return "来週までに返事が必要です。";
    };
    r.mt.auto = () => "Reply by next week.";
    await r.pipeline.submit(utterance(1));
    await r.pipeline.submit(utterance(2));
    await r.pipeline.finish();

    const errors = r.events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ detail: expect.stringContaining("device lost") });
    expect(r.finals().map((f) => f.ja)).toEqual(["来週までに返事が必要です。"]);
  });

  it("passes on an error the source reports", () => {
    const r = rig();
    r.pipeline.reportError("The microphone stopped.");
    expect(r.events).toEqual([{ kind: "error", detail: "The microphone stopped." }]);
  });
});

describe("finishing", () => {
  it("resolves only once every queued utterance is captioned", async () => {
    const r = rig();
    speaks(r.asr);
    await r.pipeline.submit(utterance(1));
    let done = false;
    const finished = r.pipeline.finish().then(() => (done = true));
    await settle();
    expect(done).toBe(false);

    r.mt.calls[0]?.finish("Understood.");
    await finished;
    expect(r.finals()).toHaveLength(1);
  });

  it("stops delivering events to a listener that unsubscribed", async () => {
    const r = rig();
    const seen: PipelineEvent[] = [];
    const off = r.pipeline.subscribe((e) => seen.push(e));
    r.pipeline.reportError("one");
    off();
    r.pipeline.reportError("two");
    expect(seen).toHaveLength(1);
  });
});

describe("falling behind", () => {
  it("reports the backlog while speech waits, then clears it", async () => {
    const r = rig(LIVE_OPTIONS);
    await r.pipeline.submit(utterance(1, { audioEndS: 2 }));
    await settle();
    r.pipeline.advanceAudio(7);
    expect(r.events.filter((e) => e.kind === "backlog").at(-1)).toEqual({ kind: "backlog", backlogS: 5, health: "behind" });

    r.asr.calls[0]?.finish("来週までに返事が必要です。");
    await settle();
    r.mt.calls[0]?.finish("Reply by next week.");
    await r.pipeline.finish();
    expect(r.events.filter((e) => e.kind === "backlog").at(-1)).toEqual({ kind: "backlog", backlogS: 0, health: "ok" });
  });

  it("does not call a long utterance behind while it is still being spoken", async () => {
    const r = rig(LIVE_OPTIONS);
    r.pipeline.advanceAudio(30);
    expect(r.events.filter((e) => e.kind === "backlog")).toEqual([]);
  });
});

describe("the en-ja pair", () => {
  function enRig() {
    const clock = new FakeClock();
    const asr = new FakeAsr();
    const mt = new FakeMt();
    const pipeline = new Pipeline({ asr, mt, clock, pair: "en-ja", glossary: () => new Map([["API", "エーピーアイ"]]), options: LIVE_OPTIONS });
    const events: PipelineEvent[] = [];
    pipeline.subscribe((e) => events.push(e));
    return { asr, mt, pipeline, events };
  }

  it("closes the line with a full stop, applies the English glossary and translates English", async () => {
    const r = enRig();
    r.asr.auto = () => "The api is ready";
    r.mt.auto = () => "APIの準備ができました。";
    await r.pipeline.submit(utterance(1));
    await r.pipeline.finish();
    expect(r.mt.finals()[0]?.ja).toBe("The エーピーアイ is ready.");
    expect(r.events.find((e) => e.kind === "final")).toMatchObject({ ja: "The api is ready", en: "APIの準備ができました。", source: "mt" });
  });

  it("emits no partial-EN preview while the speaker is still talking", async () => {
    const r = enRig();
    r.mt.auto = () => "金曜日に変更になりました。";
    const call = new Promise<void>((resolve) => {
      r.asr.auto = (c) => {
        c.segment("I wanted to tell you that the meeting moved");
        resolve();
        return "I wanted to tell you that the meeting moved to Friday.";
      };
    });
    await r.pipeline.submit(utterance(1));
    await call;
    await settle();
    expect(r.mt.previews()).toHaveLength(0);
    expect(kinds(r.events)).toContain("partial_ja");
    await r.pipeline.finish();
    expect(kinds(r.events)).not.toContain("partial_en");
  });

  it("does not revise a row when a fragment follows closely", async () => {
    const r = enRig();
    r.asr.auto = (call) => (call.samples[0] === 1 ? "I told the manager but" : "there is no reply yet.");
    r.mt.auto = (call) => `JA<${call.ja}>`;
    await r.pipeline.submit(utterance(1, { seconds: 1, audioEndS: 2 }));
    await r.pipeline.submit(utterance(2, { seconds: 1, audioEndS: 3.5 }));
    await r.pipeline.finish();
    expect(kinds(r.events).filter((k) => k === "final" || k === "revising" || k === "revision")).toEqual(["final", "final"]);
  });

  it("passes prior English lines as context", async () => {
    const r = enRig();
    r.asr.auto = (call) => (call.samples[0] === 1 ? "The quote arrived today." : "We need to reply soon.");
    r.mt.auto = (call) => `JA<${call.ja}>`;
    await r.pipeline.submit(utterance(1));
    await r.pipeline.submit(utterance(2));
    await r.pipeline.finish();
    expect(r.mt.finals()[1]?.context).toEqual([{ ja: "The quote arrived today.", en: "JA<The quote arrived today.>" }]);
  });
});

describe("cleanAsrText on English", () => {
  it("keeps ordinary English and drops punctuation-only text", () => {
    expect(cleanAsrText(asJaText("So we went to the store, and I said no, no, we can't."))).toBe("So we went to the store, and I said no, no, we can't.");
    expect(cleanAsrText(asJaText("..."))).toBeNull();
  });

  it("collapses a one-word decode loop", () => {
    expect(cleanAsrText(asJaText("no no no no no no no no"))).toBe("no no");
  });
});

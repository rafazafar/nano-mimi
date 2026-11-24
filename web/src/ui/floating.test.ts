import { describe, expect, it } from "vitest";
import { asEnText, asJaText } from "../core/types";
import { asRowId, emptyCaptions, reduceCaptions, type CaptionState, type PipelineEvent, type Timing } from "../pipeline";
import { pipModel } from "./floating";

const timing: Timing = { vadWaitS: 0.4, queueWaitS: 0, asrS: 0.2, mtS: 0.3, perceivedS: 0.9, endToEndS: 0.95 };
const run = (events: readonly PipelineEvent[]): CaptionState => events.reduce(reduceCaptions, emptyCaptions);

const settle = (n: number, en: string): PipelineEvent[] => [
  { kind: "translating", id: asRowId(n), timelineS: n, ja: asJaText(`行${n}`) },
  { kind: "final", id: asRowId(n), timelineS: n, durationS: 1, ja: asJaText(`行${n}`), en: asEnText(en), source: "mt", timing },
];

describe("pipModel", () => {
  it("is empty before anything is said", () => {
    expect(pipModel(emptyCaptions)).toEqual({ settled: [], provisional: null, health: "ok", backlogS: 0 });
  });

  it("keeps the newest settled lines, oldest first", () => {
    const model = pipModel(run([1, 2, 3, 4, 5].flatMap((n) => settle(n, `line ${n}`))));
    expect(model.settled.map((line) => line.text)).toEqual(["line 3", "line 4", "line 5"]);
    expect(model.provisional).toBeNull();
  });

  it("shows the Japanese of a row still waiting for English, then its streamed English", () => {
    const waiting = run([...settle(1, "Hello"), { kind: "translating", id: asRowId(2), timelineS: 2, ja: asJaText("次の行") }]);
    expect(pipModel(waiting).provisional).toEqual({ text: "次の行", lang: "ja" });

    const streaming = reduceCaptions(waiting, { kind: "en_token", id: asRowId(2), delta: "The next" });
    expect(pipModel(streaming).provisional).toEqual({ text: "The next", lang: "en" });
    expect(pipModel(streaming).settled.map((line) => line.text)).toEqual(["Hello"]);
  });

  it("falls back to the draft when no row is waiting", () => {
    const drafting = run([...settle(1, "Hello"), { kind: "partial_ja", ja: asJaText("来週までに"), timelineS: 3 }]);
    expect(pipModel(drafting).provisional).toEqual({ text: "来週までに", lang: "ja" });

    const previewed = reduceCaptions(drafting, { kind: "partial_en", en: asEnText("By next week"), version: 1, complete: false });
    expect(pipModel(previewed).provisional).toEqual({ text: "By next week", lang: "en" });
  });

  it("prefers the row waiting for English over a newer draft", () => {
    const state = run([{ kind: "translating", id: asRowId(1), timelineS: 1, ja: asJaText("一") }, { kind: "partial_ja", ja: asJaText("二"), timelineS: 2 }]);
    expect(pipModel(state).provisional).toEqual({ text: "一", lang: "ja" });
  });

  it("carries health and backlog from the same state", () => {
    const model = pipModel(run([{ kind: "backlog", backlogS: 7, health: "behind" }]));
    expect(model).toMatchObject({ health: "behind", backlogS: 7 });
  });

  it("honours a smaller window", () => {
    const model = pipModel(run([1, 2, 3].flatMap((n) => settle(n, `line ${n}`))), 1);
    expect(model.settled.map((line) => line.text)).toEqual(["line 3"]);
  });
});

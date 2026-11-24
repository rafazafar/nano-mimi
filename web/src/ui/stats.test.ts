import { describe, expect, it } from "vitest";
import { asEnText, asJaText } from "../core/types";
import { emptyCaptions, reduceCaptions, type CaptionState } from "../pipeline";
import { asRowId, type PipelineEvent, type Timing } from "../pipeline";
import { perceivedStats } from "./stats";

const timing = (perceivedS: number): Timing => ({ vadWaitS: 0.4, queueWaitS: 0, asrS: 0.2, mtS: 0.3, perceivedS, endToEndS: perceivedS });

const settle = (n: number, perceivedS: number): PipelineEvent[] => [
  { kind: "translating", id: asRowId(n), timelineS: n, ja: asJaText("はい") },
  { kind: "final", id: asRowId(n), timelineS: n, durationS: 1, ja: asJaText("はい"), en: asEnText("Yes"), source: "mt", timing: timing(perceivedS) },
];

const run = (events: readonly PipelineEvent[]): CaptionState => events.reduce(reduceCaptions, emptyCaptions);

describe("perceivedStats", () => {
  it("is null before any row has settled", () => {
    expect(perceivedStats(run([]).rows)).toBeNull();
    expect(perceivedStats(run([{ kind: "translating", id: asRowId(1), timelineS: 0, ja: asJaText("はい") }]).rows)).toBeNull();
  });

  it("takes p50 and p95 over settled rows only", () => {
    const state = run([
      ...[1, 2, 3, 4, 5].flatMap((i) => settle(i, i)),
      { kind: "translating", id: asRowId(6), timelineS: 6, ja: asJaText("まだ") },
    ]);
    const stats = perceivedStats(state.rows);
    expect(stats?.count).toBe(5);
    expect(stats?.p50).toBe(3);
    expect(stats?.p95).toBeCloseTo(4.8, 10);
  });

  it("counts a revised row once, with its latest timing", () => {
    const state = run([
      ...settle(1, 1),
      ...settle(2, 3),
      { kind: "revising", targetId: asRowId(1), ja: asJaText("はい、そうです") },
      {
        kind: "revision",
        targetId: asRowId(1),
        mergedIds: [asRowId(2)],
        timelineS: 1,
        durationS: 2,
        ja: asJaText("はい、そうです"),
        en: asEnText("Yes, that is right"),
        source: "mt",
        timing: timing(2),
      },
    ]);
    expect(perceivedStats(state.rows)?.count).toBe(2);
    expect(perceivedStats(state.rows)?.p50).toBe(2.5);
  });
});

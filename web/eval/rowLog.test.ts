import { describe, expect, it } from "vitest";
import { asEnText, asJaText } from "../src/core/types";
import { asRowId, type PipelineEvent, type Timing } from "../src/pipeline";
import { RowLog } from "./rowLog";

const timing = (over: Partial<Timing> = {}): Timing => ({ vadWaitS: 0.4, queueWaitS: 0.1, asrS: 0.2, mtS: 0.3, perceivedS: 1, endToEndS: 1.1, ...over });
const one = asRowId(1);
const two = asRowId(2);

const final = (id: typeof one, ja: string, en: string, t: Timing, timelineS = 2): PipelineEvent => ({
  kind: "final",
  id,
  timelineS,
  durationS: 1.5,
  ja: asJaText(ja),
  en: asEnText(en),
  source: "mt",
  timing: t,
});

const run = (events: readonly PipelineEvent[]) => {
  const log = new RowLog();
  for (const event of events) log.apply(event);
  return log.snapshot();
};

describe("RowLog", () => {
  it("records a settled row with the Python log's field names and units", () => {
    const { rows } = run([
      { kind: "translating", id: one, timelineS: 2, ja: asJaText("はい。") },
      final(one, "はい。", "Yes.", timing()),
    ]);
    expect(rows).toEqual([
      {
        id: 1,
        ja: "はい。",
        en: "Yes.",
        timeline_s: 2,
        duration_s: 1.5,
        vad_wait_s: 0.4,
        queue_wait_s: 0.1,
        asr_latency_s: 0.2,
        translate_latency_s: 0.3,
        merged_ids: [],
        source: "mt",
      },
    ]);
  });

  it("folds a merged fragment into its target row the way the Python log does", () => {
    const { rows } = run([
      { kind: "translating", id: one, timelineS: 2, ja: asJaText("部長には") },
      final(one, "部長には", "To the manager", timing()),
      { kind: "revising", targetId: one, ja: asJaText("部長には報告しました。") },
      {
        kind: "revision",
        targetId: one,
        mergedIds: [two],
        timelineS: 2,
        durationS: 3.5,
        ja: asJaText("部長には報告しました。"),
        en: asEnText("I reported to the manager."),
        source: "mt",
        timing: timing({ vadWaitS: 0.9, queueWaitS: 0.9, asrS: 0.9, mtS: 0.5 }),
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ja: "部長には報告しました。",
      en: "I reported to the manager.",
      duration_s: 3.5,
      merged_ids: [2],
      // The first fragment's VAD, queue and ASR stay; the translation times add up.
      vad_wait_s: 0.4,
      queue_wait_s: 0.1,
      asr_latency_s: 0.2,
    });
    expect(rows[0]?.translate_latency_s).toBeCloseTo(0.8);
  });

  it("orders rows by id and ignores provisional events", () => {
    const { rows, unsettled } = run([
      { kind: "partial_ja", ja: asJaText("あ"), timelineS: 0 },
      { kind: "partial_en", en: asEnText("Ah"), version: 1, complete: false },
      { kind: "translating", id: two, timelineS: 5, ja: asJaText("二番") },
      { kind: "translating", id: one, timelineS: 2, ja: asJaText("一番") },
      { kind: "en_token", id: one, delta: "One" },
      final(two, "二番", "Two", timing(), 5),
      final(one, "一番", "One", timing()),
    ]);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(unsettled).toBe(0);
  });

  it("counts rows that never settled, and keeps errors and the worst backlog", () => {
    const { rows, unsettled, errors, maxBacklogS } = run([
      { kind: "translating", id: one, timelineS: 0, ja: asJaText("途中") },
      { kind: "backlog", backlogS: 1.5, health: "ok" },
      { kind: "backlog", backlogS: 6, health: "behind" },
      { kind: "backlog", backlogS: 2, health: "ok" },
      { kind: "error", detail: "Speech recognition failed: boom" },
    ]);
    expect(rows).toEqual([]);
    expect(unsettled).toBe(1);
    expect(errors).toEqual(["Speech recognition failed: boom"]);
    expect(maxBacklogS).toBe(6);
  });
});

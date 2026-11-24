import { describe, expect, it } from "vitest";
import { asEnText, asJaText } from "../core/types";
import { asRowId, emptyCaptions, reduceCaptions, type CaptionState, type PipelineEvent, type Timing } from "../pipeline";
import { draftView, isNearBottom, rowView, timingRows } from "./transcript";

const timing: Timing = { vadWaitS: 0.4, queueWaitS: 0.05, asrS: 0.2, mtS: 0.3, perceivedS: 0.95, endToEndS: 1.2 };
const one = asRowId(1);
const run = (events: readonly PipelineEvent[]): CaptionState => events.reduce(reduceCaptions, emptyCaptions);
const first = (state: CaptionState) => {
  const row = state.rows[0];
  if (row === undefined) throw new Error("no row");
  return row;
};

const opened: PipelineEvent = { kind: "translating", id: one, timelineS: 65, ja: asJaText("部長には報告しましたが、") };
const settled: PipelineEvent = {
  kind: "final",
  id: one,
  timelineS: 65,
  durationS: 2,
  ja: asJaText("部長には報告しましたが、"),
  en: asEnText("I reported to the manager, but"),
  source: "mt",
  timing,
};

describe("rowView", () => {
  it("shows a translating row as provisional with the streamed English", () => {
    const view = rowView(first(run([opened, { kind: "en_token", id: one, delta: "I told" }])));
    expect(view).toMatchObject({ time: "01:05", en: "I told", enProvisional: true, provisional: true, revising: false, placeholder: "Translating" });
  });

  it("shows a settled row as firm", () => {
    const view = rowView(first(run([opened, settled])));
    expect(view).toMatchObject({ en: "I reported to the manager, but", enProvisional: false, jaProvisional: false, provisional: false, source: "mt", placeholder: "" });
  });

  it("keeps the old English and marks the new Japanese provisional until the revision streams", () => {
    const state = run([opened, settled, { kind: "revising", targetId: one, ja: asJaText("部長には報告しましたが、まだ返事がありません。") }]);
    expect(rowView(first(state))).toMatchObject({
      ja: "部長には報告しましたが、まだ返事がありません。",
      jaProvisional: true,
      en: "I reported to the manager, but",
      enProvisional: false,
      provisional: true,
      revising: true,
    });
  });

  it("swaps to the streamed English once the revision starts producing it", () => {
    const state = run([opened, settled, { kind: "revising", targetId: one, ja: asJaText("部長には報告しましたが、まだ返事がありません。") }, { kind: "en_token", id: one, delta: "I told" }]);
    expect(rowView(first(state))).toMatchObject({ en: "I told", enProvisional: true, revising: true });
  });

  it("counts revisions after the line is rewritten in place", () => {
    const state = run([
      opened,
      settled,
      { kind: "revising", targetId: one, ja: asJaText("部長には報告しましたが、まだ返事がありません。") },
      {
        kind: "revision",
        targetId: one,
        mergedIds: [asRowId(2)],
        timelineS: 65,
        durationS: 4,
        ja: asJaText("部長には報告しましたが、まだ返事がありません。"),
        en: asEnText("I reported to the manager, but there is no reply yet."),
        source: "mt",
        timing,
      },
    ]);
    expect(rowView(first(state))).toMatchObject({ revisions: 1, revising: false, provisional: false, en: "I reported to the manager, but there is no reply yet." });
  });

  it("says so when a settled row has no English", () => {
    const state = run([opened, { ...settled, en: asEnText(""), source: "failed" }]);
    expect(rowView(first(state))).toMatchObject({ en: "", placeholder: "Translation unavailable" });
  });
});

describe("draftView", () => {
  it("formats the draft's time and passes its text through", () => {
    const state = run([
      { kind: "partial_ja", ja: asJaText("来週までに"), timelineS: 3725 },
      { kind: "partial_en", en: asEnText("By next week"), version: 1, complete: false },
    ]);
    expect(draftView(state.draft!)).toEqual({ time: "1:02:05", ja: "来週までに", en: "By next week" });
  });
});

describe("timingRows", () => {
  it("lists the source and every stage in order", () => {
    const rows = timingRows(timing, "mt");
    expect(rows.map(([label]) => label)).toEqual(["English from", "VAD wait", "Queue wait", "Speech recognition", "Translation", "Perceived", "End to end"]);
    expect(rows[0]).toEqual(["English from", "mt"]);
    expect(rows[5]?.[1]).toContain("0.95");
  });

  it("shows a dash where the source is unknown", () => {
    expect(timingRows(timing, null)[0]).toEqual(["English from", "-"]);
  });
});

describe("isNearBottom", () => {
  it("is true at the end and within the threshold", () => {
    expect(isNearBottom({ scrollTop: 500, clientHeight: 500, scrollHeight: 1000 })).toBe(true);
    expect(isNearBottom({ scrollTop: 460, clientHeight: 500, scrollHeight: 1000 })).toBe(true);
  });

  it("is false once the user has scrolled further up", () => {
    expect(isNearBottom({ scrollTop: 300, clientHeight: 500, scrollHeight: 1000 })).toBe(false);
  });

  it("is true when the content fits without scrolling", () => {
    expect(isNearBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 300 })).toBe(true);
  });
});

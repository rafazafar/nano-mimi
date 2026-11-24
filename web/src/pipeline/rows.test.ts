import { describe, expect, it } from "vitest";
import { asEnText, asJaText } from "../core/types";
import { emptyCaptions, reduceCaptions, type CaptionState } from "./rows";
import { asRowId, type PipelineEvent, type Timing } from "./types";

const timing: Timing = { vadWaitS: 0.4, queueWaitS: 0, asrS: 0.2, mtS: 0.3, perceivedS: 0.9, endToEndS: 0.95 };
const run = (events: readonly PipelineEvent[]): CaptionState => events.reduce(reduceCaptions, emptyCaptions);

const one = asRowId(1);
const two = asRowId(2);

describe("caption rows", () => {
  it("shows the draft JA and its preview until ASR finishes the line, then opens a row", () => {
    const drafting = run([
      { kind: "partial_ja", ja: asJaText("来週までに返事を"), timelineS: 3 },
      { kind: "partial_en", en: asEnText("Reply by next"), version: 1, complete: false },
    ]);
    expect(drafting.draft).toMatchObject({ ja: "来週までに返事を", previewEn: "Reply by next", previewComplete: false });
    expect(drafting.rows).toEqual([]);

    const translating = reduceCaptions(drafting, {
      kind: "translating",
      id: one,
      timelineS: 3,
      ja: asJaText("来週までに返事をします。"),
    });
    expect(translating.draft).toBeNull();
    expect(translating.rows).toMatchObject([{ id: 1, status: "translating", ja: "来週までに返事をします。", en: "" }]);
  });

  it("streams English into the open row and replaces it with the settled translation", () => {
    const open: PipelineEvent[] = [
      { kind: "translating", id: one, timelineS: 0, ja: asJaText("はい、わかりました。") },
      { kind: "en_token", id: one, delta: "Yes, " },
      { kind: "en_token", id: one, delta: "understood" },
    ];
    expect(run(open).rows[0]).toMatchObject({ status: "translating", streamed: "Yes, understood", en: "" });

    const settled = run([
      ...open,
      { kind: "final", id: one, timelineS: 0, durationS: 1.5, ja: asJaText("はい、わかりました。"), en: asEnText("Yes, understood."), source: "mt", timing },
    ]);
    expect(settled.rows[0]).toMatchObject({ status: "settled", en: "Yes, understood.", streamed: "", durationS: 1.5, source: "mt" });
  });

  it("rewrites the target row in place on a revision and leaves the other rows alone", () => {
    const base: PipelineEvent[] = [
      { kind: "translating", id: one, timelineS: 0, ja: asJaText("部長には報告しましたが、") },
      { kind: "final", id: one, timelineS: 0, durationS: 2, ja: asJaText("部長には報告しましたが、"), en: asEnText("I reported to the manager, but"), source: "mt", timing },
      { kind: "translating", id: asRowId(9), timelineS: 9, ja: asJaText("別の話です。") },
    ];
    const revising = run([...base, { kind: "revising", targetId: one, ja: asJaText("部長には報告しましたが、まだ返事がありません。") }, { kind: "en_token", id: one, delta: "I told" }]);
    expect(revising.rows[0]).toMatchObject({ en: "I reported to the manager, but", revising: { streamed: "I told" } });
    expect(revising.rows[0]?.streamed).toBe("");

    const revised = reduceCaptions(revising, {
      kind: "revision",
      targetId: one,
      mergedIds: [two],
      timelineS: 0,
      durationS: 4.5,
      ja: asJaText("部長には報告しましたが、まだ返事がありません。"),
      en: asEnText("I reported to the manager, but there is no reply yet."),
      source: "mt",
      timing,
    });
    expect(revised.rows[0]).toMatchObject({
      id: 1,
      status: "settled",
      ja: "部長には報告しましたが、まだ返事がありません。",
      en: "I reported to the manager, but there is no reply yet.",
      mergedIds: [2],
      revisions: 1,
      revising: null,
      durationS: 4.5,
    });
    expect(revised.rows).toHaveLength(2);
    expect(revised.rows[1]).toMatchObject({ id: 9, status: "translating" });
  });

  it("drops the revising mark when the merge fails", () => {
    const state = run([
      { kind: "translating", id: one, timelineS: 0, ja: asJaText("あ、") },
      { kind: "final", id: one, timelineS: 0, durationS: 1, ja: asJaText("あ、"), en: asEnText("Uh,"), source: "mt", timing },
      { kind: "revising", targetId: one, ja: asJaText("あ、いえ") },
      { kind: "revision_failed", targetId: one },
    ]);
    expect(state.rows[0]).toMatchObject({ revising: null, revisions: 0, en: "Uh," });
  });

  it("ignores a preview older than the one on screen", () => {
    const state = run([
      { kind: "partial_ja", ja: asJaText("会議の資料を準備します。"), timelineS: 1 },
      { kind: "partial_en", en: asEnText("newer"), version: 4, complete: true },
      { kind: "partial_en", en: asEnText("older"), version: 3, complete: true },
    ]);
    expect(state.draft?.previewEn).toBe("newer");
  });

  it("tracks the backlog and clears an error once a row settles", () => {
    const behind = run([{ kind: "backlog", backlogS: 5.2, health: "behind" }, { kind: "error", detail: "Could not translate this caption." }]);
    expect(behind).toMatchObject({ health: "behind", backlogS: 5.2, error: "Could not translate this caption." });
    const recovered = [
      { kind: "translating", id: one, timelineS: 0, ja: asJaText("はい。") },
      { kind: "final", id: one, timelineS: 0, durationS: 1, ja: asJaText("はい。"), en: asEnText("Yes."), source: "cache", timing },
      { kind: "backlog", backlogS: 0.5, health: "ok" },
    ] satisfies PipelineEvent[];
    expect(recovered.reduce(reduceCaptions, behind)).toMatchObject({ health: "ok", error: null });
  });
});

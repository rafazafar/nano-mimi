import { describe, expect, it } from "vitest";
import { asEnText, asJaText } from "../core/types";
import { displayHarness, type DisplayHarness } from "./harness";
import { kinds, settle } from "./testing";
import type { PipelineEvent } from "./types";

/** Answers every translation with `EN<ja>`, so the JA a call received shows in the English. */
function echoing(h: DisplayHarness): void {
  h.mt.auto = (call) => `EN<${call.ja}>`;
}

const only = <K extends PipelineEvent["kind"]>(events: readonly PipelineEvent[], kind: K): Extract<PipelineEvent, { kind: K }>[] =>
  events.filter((e): e is Extract<PipelineEvent, { kind: K }> => e.kind === kind);

describe("translating a final", () => {
  it("passes the prior lines as context, oldest first, and starts with none", async () => {
    const h = displayHarness({ partialEn: false });
    h.mt.auto = (call) => (call.ja.startsWith("見積もり") ? "A quote arrived" : "We need to reply by next week");
    h.final("見積もりが届きました。");
    h.final("来週までに返事が必要です。");
    await h.stage.idle();

    expect(h.mt.finals()[0]?.context).toEqual([]);
    expect(h.mt.finals()[1]?.context).toEqual([{ ja: "見積もりが届きました。", en: "A quote arrived" }]);
  });

  it("starts each session with no context", async () => {
    const first = displayHarness({ partialEn: false });
    first.mt.auto = () => "A quote arrived";
    first.final("見積もりが届きました。");
    await first.stage.idle();

    const second = displayHarness({ partialEn: false });
    second.mt.auto = () => "Reply by next week";
    second.final("来週までに返事が必要です。");
    await second.stage.idle();
    expect(second.mt.calls[0]?.context).toEqual([]);
  });

  it("shows mostly-English speech as it is, without calling MT or feeding it to the context", async () => {
    const h = displayHarness({ partialEn: false });
    h.mt.auto = (call) => (call.ja.startsWith("見積もり") ? "A quote arrived" : "Reply by next week");
    h.final("見積もりが届きました。");
    h.final("Let's circle back on that.");
    h.final("来週までに返事が必要です。");
    await h.stage.idle();

    expect(h.mt.calls).toHaveLength(2);
    expect(h.mt.calls[1]?.context).toEqual([{ ja: "見積もりが届きました。", en: "A quote arrived" }]);
    expect(only(h.events, "final")[1]).toMatchObject({ en: "Let's circle back on that.", source: "passthrough" });
  });

  it("drops the trailing Japanese full stop from a passthrough line", async () => {
    const h = displayHarness({ partialEn: false });
    h.final("Sounds good。");
    await h.stage.idle();
    expect(only(h.events, "final")[0]?.en).toBe("Sounds good");
    expect(h.mt.calls).toEqual([]);
  });

  it("judges passthrough on the text before the glossary: a line that only turns English by a term swap still goes to MT", async () => {
    const h = displayHarness({ partialEn: false, glossary: new Map([["ミミボックス", "MimiVox"]]) });
    echoing(h);
    h.final("ミミボックス。");
    await h.stage.idle();
    expect(h.mt.calls).toHaveLength(1);
    expect(h.mt.calls[0]?.ja).toBe("MimiVox。");
  });

  it("answers a repeated line from the cache without calling MT again", async () => {
    const h = displayHarness({ partialEn: false });
    h.mt.auto = () => "We need to reply by next week";
    h.final("来週までに返事が必要です。");
    h.final("来週までに返事が必要です。");
    await h.stage.idle();

    expect(h.mt.calls).toHaveLength(1);
    expect(only(h.events, "final").map((e) => [e.source, e.en])).toEqual([
      ["mt", "We need to reply by next week"],
      ["cache", "We need to reply by next week"],
    ]);
  });

  it("answers a stock phrase from the cache", async () => {
    const h = displayHarness({ partialEn: false });
    h.final("ありがとう。");
    await h.stage.idle();
    expect(only(h.events, "final")[0]).toMatchObject({ en: "Thank you.", source: "cache" });
    expect(h.mt.calls).toEqual([]);
  });

  it("does not cache an empty translation, so the next occurrence tries again", async () => {
    const h = displayHarness({ partialEn: false });
    h.mt.auto = () => "";
    h.final("来週までに返事が必要です。");
    await h.stage.idle();
    expect(only(h.events, "final")[0]).toMatchObject({ en: "", source: "failed" });

    h.mt.auto = () => "Reply by next week";
    h.final("来週までに返事が必要です。");
    await h.stage.idle();
    expect(h.mt.calls).toHaveLength(2);
    expect(only(h.events, "final")[1]).toMatchObject({ en: "Reply by next week", source: "mt" });
  });

  it("opens a row, streams its English and settles it, in that order", async () => {
    const h = displayHarness({ partialEn: false });
    h.mt.auto = () => "Understood";
    h.final("わかりました。資料は私が準備します。");
    await h.stage.idle();
    expect(kinds(h.events)).toEqual(["translating", "en_token", "final"]);
    expect(only(h.events, "en_token")[0]).toMatchObject({ id: 1, delta: "Understood" });
  });

  it("reports an MT failure and keeps going with an empty row", async () => {
    const h = displayHarness({ partialEn: false });
    h.mt.translate = () => ({ outcome: Promise.reject(new Error("device lost")), cancel: () => undefined });
    h.final("来週までに返事が必要です。");
    await h.stage.idle();
    expect(only(h.events, "error")).toHaveLength(1);
    expect(only(h.events, "final")[0]).toMatchObject({ en: "", source: "failed" });
  });

  it("reads the glossary at each line, so an edit applies to the next one", async () => {
    const glossary = new Map<string, string>();
    const h = displayHarness({ partialEn: false, glossary });
    echoing(h);
    h.final("部長に報告します。");
    await h.stage.idle();
    glossary.set("部長", "the department head");
    h.final("部長に連絡します。");
    await h.stage.idle();
    expect(h.mt.calls.map((c) => c.ja)).toEqual(["部長に報告します。", "the department headに連絡します。"]);
  });

  it("stamps each stage's time, with perceived latency the eval's sum and end-to-end counted from the end of speech", async () => {
    const h = displayHarness({ partialEn: false });
    h.mt.auto = () => {
      h.clock.advance(300);
      return "Yes.";
    };
    h.final("わかりました。資料は私が準備します。", { vadWaitS: 0.4, queueWaitS: 0.1, asrS: 0.25, speechEndMs: -1000 });
    await h.stage.idle();
    const { timing } = only(h.events, "final")[0]!;
    expect(timing.mtS).toBeCloseTo(0.3);
    expect(timing.perceivedS).toBeCloseTo(0.4 + 0.1 + 0.25 + 0.3);
    expect(timing.endToEndS).toBeCloseTo(1.3);
  });

  it("charges no MT time to a line answered from the cache or passed through", async () => {
    const h = displayHarness({ partialEn: false });
    h.final("ありがとう。", { vadWaitS: 0.4, queueWaitS: 0, asrS: 0.2 });
    await h.stage.idle();
    const { timing } = only(h.events, "final")[0]!;
    expect(timing.mtS).toBe(0);
    expect(timing.perceivedS).toBeCloseTo(0.6);
  });
});

describe("revising a split sentence", () => {
  const line1 = "先月より二割高いですね。";
  const first = "部長には報告しましたが、";
  const second = "まだ返事がありません。";
  const joined = "部長には報告しましたが、まだ返事がありません。";

  it("merges a VAD-split fragment into the previous row and re-translates the joined line", async () => {
    const h = displayHarness({ partialEn: false });
    echoing(h);
    h.final(line1, { timelineS: 0, durationS: 2 });
    h.final(first, { timelineS: 4, durationS: 2 });
    h.final(second, { timelineS: 6.8, durationS: 2 });
    h.final("そうですか。", { timelineS: 12, durationS: 1 });
    await h.stage.idle();

    expect(only(h.events, "final").map((e) => e.id)).toEqual([1, 2, 4]);
    const revisions = only(h.events, "revision");
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ targetId: 2, mergedIds: [3], ja: joined, en: `EN<${joined}>`, source: "mt" });
    expect(revisions[0]?.durationS).toBeCloseTo(4.8);
    expect(revisions[0]?.timelineS).toBe(4);
  });

  it("translates the joined line with the context from before the first half, and later lines see the merged row", async () => {
    const h = displayHarness({ partialEn: false });
    echoing(h);
    h.final(line1, { timelineS: 0, durationS: 2 });
    h.final(first, { timelineS: 4, durationS: 2 });
    h.final(second, { timelineS: 6.8, durationS: 2 });
    h.final("そうですか。", { timelineS: 12, durationS: 1 });
    await h.stage.idle();

    const byJa = new Map(h.mt.calls.map((c) => [c.ja, c.context.map((t) => t.ja)]));
    expect(byJa.get(joined)).toEqual([line1]);
    expect(byJa.get("そうですか。")).toEqual([line1, joined]);
  });

  it("marks the target row as revising while the joined line translates, before any revision lands", async () => {
    const h = displayHarness({ partialEn: false });
    echoing(h);
    h.final(first, { timelineS: 0, durationS: 2 });
    h.final(second, { timelineS: 2.8, durationS: 2 });
    await h.stage.idle();
    expect(kinds(h.events)).toEqual(["translating", "en_token", "final", "revising", "en_token", "revision"]);
    expect(only(h.events, "revising")[0]).toMatchObject({ targetId: 1, ja: joined });
    expect(only(h.events, "en_token")[1]).toMatchObject({ id: 1 });
  });

  it("can merge a third fragment into the same row", async () => {
    const h = displayHarness({ partialEn: false });
    echoing(h);
    h.final("明日の会議で、", { timelineS: 0, durationS: 2 });
    h.final("資料を見せながら、", { timelineS: 2.5, durationS: 2 });
    h.final("説明します。", { timelineS: 5, durationS: 2 });
    await h.stage.idle();
    const revisions = only(h.events, "revision");
    expect(revisions.map((r) => r.mergedIds)).toEqual([[2], [2, 3]]);
    expect(revisions[1]?.ja).toBe("明日の会議で、資料を見せながら、説明します。");
  });

  it("never revises sentences that were not split", async () => {
    const h = displayHarness({ partialEn: false });
    echoing(h);
    h.final("田中さんから新しい見積もりが届きました。", { timelineS: 0, durationS: 3 });
    h.final("先月より二割高いですね。", { timelineS: 5, durationS: 2 });
    h.final("来週までに返事をしないといけないですね。", { timelineS: 8, durationS: 3 });
    await h.stage.idle();
    expect(only(h.events, "revision")).toEqual([]);
    expect(only(h.events, "final")).toHaveLength(3);
  });

  it("does not merge across a pause longer than a second and a half", async () => {
    const h = displayHarness({ partialEn: false });
    echoing(h);
    h.final(first, { timelineS: 0, durationS: 2 });
    h.final(second, { timelineS: 5, durationS: 2 });
    await h.stage.idle();
    expect(only(h.events, "revision")).toEqual([]);
    expect(only(h.events, "final")).toHaveLength(2);
  });

  it("falls back to a row of its own when the joined line translates to nothing", async () => {
    const h = displayHarness({ partialEn: false });
    h.mt.auto = (call) => (call.ja === joined ? "" : `EN<${call.ja}>`);
    h.final(first, { timelineS: 0, durationS: 2 });
    h.final(second, { timelineS: 2.8, durationS: 2 });
    await h.stage.idle();
    expect(kinds(h.events)).toContain("revision_failed");
    expect(only(h.events, "revision")).toEqual([]);
    expect(only(h.events, "final").map((e) => e.id)).toEqual([1, 2]);
  });
});

describe("previews", () => {
  const ja = "定年評価インデックスページを移植してほしいです。";

  it("accumulates the partial JA of an utterance and shows it until the final", async () => {
    const h = displayHarness({ partialEn: false });
    h.partial("定年評価インデックス");
    h.partial("ページを移植して");
    await h.stage.idle();
    expect(only(h.events, "partial_ja").map((e) => e.ja)).toEqual(["定年評価インデックス", "定年評価インデックス ページを移植して"]);
  });

  it("seeds the cache from a complete preview, so the final needs no translation of its own", async () => {
    const h = displayHarness();
    h.mt.auto = () => "We will migrate the index page next.";
    h.partial(ja);
    await h.stage.idle();
    await h.coordinator.inFlight;

    expect(h.mt.previews()).toHaveLength(1);
    expect(only(h.events, "partial_en").at(-1)).toMatchObject({ en: "We will migrate the index page next.", complete: true });

    h.final(ja);
    await h.stage.idle();
    expect(h.mt.finals()).toHaveLength(0);
    expect(only(h.events, "final")[0]).toMatchObject({ en: "We will migrate the index page next.", source: "cache" });
  });

  it("gives the preview the same context the final will see", async () => {
    const h = displayHarness();
    h.context.add(asJaText("見積もりが届きました。"), asEnText("A quote arrived"));
    h.mt.auto = () => "Reply by next week.";
    h.partial("来週までに返事をしないといけないですね。");
    await h.stage.idle();
    await h.coordinator.inFlight;
    expect(h.mt.previews()[0]?.context).toEqual([{ ja: "見積もりが届きました。", en: "A quote arrived" }]);
  });

  it("does not seed the cache from a truncated preview of a long line", async () => {
    const h = displayHarness();
    const long = "来週の水曜日までに、先月の見積もりと今月の請求書を照らし合わせた結果を、部長に報告しなければなりません。";
    h.mt.auto = () => "By next Wednesday we must compare last month's quote with";
    h.partial(long);
    await h.stage.idle();
    await h.coordinator.inFlight;
    expect(h.cache.has(asJaText(long))).toBe(false);
    expect(only(h.events, "partial_en").at(-1)).toMatchObject({ complete: false });
  });

  it("lets a final preempt a preview in flight: the preview stops, the final translates, no preview text appears after it", async () => {
    const h = displayHarness();
    h.partial(ja);
    await h.stage.idle();
    expect(h.mt.previews()).toHaveLength(1);
    const preview = h.mt.previews()[0]!;
    expect(preview.cancelled).toBe(false);

    h.mt.auto = () => "Final English.";
    h.final(ja);
    await h.stage.idle();
    await settle();

    expect(preview.cancelled).toBe(true);
    const finalAt = h.events.findIndex((e) => e.kind === "final");
    expect(only(h.events, "final")[0]).toMatchObject({ en: "Final English.", source: "mt" });
    expect(h.events.slice(finalAt).some((e) => e.kind === "partial_en")).toBe(false);
    // The aborted preview seeded nothing: the cache holds the final's translation.
    expect(h.cache.lookup(asJaText(ja))).toBe("Final English.");
  });
});

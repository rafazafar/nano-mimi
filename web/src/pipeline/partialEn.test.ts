import { describe, expect, it } from "vitest";
import { asJaText } from "../core/types";
import { displayHarness } from "./harness";
import { PartialEnCoordinator } from "./partialEn";
import { deferred, settle } from "./testing";
import type { PipelineEvent } from "./types";

const ja = asJaText;
/** `n` Japanese characters with no clause end. */
const run = (n: number): ReturnType<typeof asJaText> => ja("あ".repeat(n));
/** The line a preview of `run(n)` sends, and so the cache key it seeds: normalization closes the sentence. */
const sent = (n: number): ReturnType<typeof asJaText> => ja(`${"あ".repeat(n)}。`);
const partials = (events: readonly PipelineEvent[]) => events.filter((e): e is Extract<PipelineEvent, { kind: "partial_en" }> => e.kind === "partial_en");

describe("when a preview starts", () => {
  it("waits for 8 characters at the least", async () => {
    const h = displayHarness();
    h.coordinator.schedule(ja("はい。"));
    h.coordinator.schedule(ja("わかりました。"));
    expect(h.mt.previews()).toHaveLength(0);
  });

  it("starts a short line at a clause end", async () => {
    const h = displayHarness();
    h.coordinator.schedule(ja("来週までに返事をします。"));
    await settle();
    expect(h.mt.previews()).toHaveLength(1);
  });

  it("holds a short line with no clause end until it reaches 20 characters", async () => {
    const h = displayHarness();
    h.coordinator.schedule(run(19));
    expect(h.mt.previews()).toHaveLength(0);
    h.coordinator.schedule(run(PartialEnCoordinator.PREFER_LEN));
    await settle();
    expect(h.mt.previews()).toHaveLength(1);
  });

  it("does not preview mostly-English text", async () => {
    const h = displayHarness();
    h.coordinator.schedule(ja("Let's circle back on that tomorrow morning."));
    expect(h.mt.previews()).toHaveLength(0);
  });

  it("does nothing when previews are off", async () => {
    const h = displayHarness({ partialEn: false });
    h.coordinator.schedule(run(30));
    expect(h.mt.previews()).toHaveLength(0);
  });

  it("does nothing for a line the cache already holds", async () => {
    const h = displayHarness();
    h.cache.storePreview(ja("来週までに返事をします。"), "I will reply by next week." as never);
    h.coordinator.schedule(ja("来週までに返事をします。"));
    expect(h.mt.previews()).toHaveLength(0);
  });

  it("sends the text the final will send, glossary applied, so the cache entry it seeds is the final's", async () => {
    const h = displayHarness({ glossary: new Map([["ミミボックス", "MimiVox"]]) });
    h.mt.auto = () => "Please open MimiVox now.";
    h.coordinator.schedule(ja("ミミボックスを開いてください。"));
    await h.coordinator.inFlight;
    expect(h.mt.previews()[0]?.ja).toBe("MimiVoxを開いてください。");
    expect(h.cache.has(ja("MimiVoxを開いてください。"))).toBe(true);
  });
});

describe("how many previews run", () => {
  it("keeps one in flight and ignores a second offer meanwhile", async () => {
    const h = displayHarness();
    h.coordinator.schedule(run(20));
    h.coordinator.schedule(run(40));
    h.coordinator.schedule(run(60));
    await settle();
    expect(h.mt.previews()).toHaveLength(1);
  });

  it("re-previews only after the line has grown by 12 characters", async () => {
    const h = displayHarness();
    h.mt.auto = () => "Some English.";
    h.coordinator.schedule(run(20));
    await h.coordinator.inFlight;
    h.coordinator.schedule(run(20 + PartialEnCoordinator.REPREVIEW_GROWTH - 1));
    expect(h.mt.previews()).toHaveLength(1);
    h.coordinator.schedule(run(20 + PartialEnCoordinator.REPREVIEW_GROWTH));
    await h.coordinator.inFlight;
    expect(h.mt.previews()).toHaveLength(2);
  });

  it("starts afresh for the next utterance", async () => {
    const h = displayHarness();
    h.mt.auto = () => "Some English.";
    h.coordinator.schedule(run(20));
    await h.coordinator.inFlight;
    h.coordinator.cancel();
    h.coordinator.resetUtterance();
    h.coordinator.schedule(run(21));
    await h.coordinator.inFlight;
    expect(h.mt.previews()).toHaveLength(2);
  });

  it("tries again later when the GPU was busy and skipped the preview", async () => {
    const h = displayHarness();
    const busy = deferred<void>();
    h.gpu.submit("asr", () => busy.promise);
    h.coordinator.schedule(run(20));
    await h.coordinator.inFlight;
    expect(h.mt.previews()).toHaveLength(0);

    busy.resolve();
    await settle();
    h.coordinator.schedule(run(21));
    await settle();
    expect(h.mt.previews()).toHaveLength(1);
  });

  it("recovers when a preview throws", async () => {
    const h = displayHarness();
    h.mt.translate = () => ({ outcome: Promise.reject(new Error("device lost")), cancel: () => undefined });
    h.coordinator.schedule(run(20));
    await h.coordinator.inFlight;
    expect(h.coordinator.inFlight).toBeNull();
    expect(partials(h.events)).toEqual([]);
  });
});

describe("what a preview shows", () => {
  it("streams its English as it comes, provisional, then closes with the whole text", async () => {
    const h = displayHarness();
    h.coordinator.schedule(run(20));
    await settle();
    const call = h.mt.previews()[0]!;
    call.finish("Please send the file.");
    await h.coordinator.inFlight;
    expect(partials(h.events).map((e) => [e.en, e.complete])).toEqual([
      ["Please send the file.", false],
      ["Please send the file.", true],
    ]);
  });

  it("tags every event of one preview with its version, which a later preview raises", async () => {
    const h = displayHarness();
    h.mt.auto = () => "One.";
    h.coordinator.schedule(run(20));
    await h.coordinator.inFlight;
    h.coordinator.schedule(run(40));
    await h.coordinator.inFlight;
    const versions = partials(h.events).map((e) => e.version);
    expect(new Set(versions.slice(0, 2)).size).toBe(1);
    expect(versions.at(-1)).toBeGreaterThan(versions[0]!);
  });

  it("seeds the cache from a complete preview", async () => {
    const h = displayHarness();
    h.mt.auto = () => "Please send the file.";
    h.coordinator.schedule(run(20));
    await h.coordinator.inFlight;
    expect(h.cache.has(sent(20))).toBe(true);
  });

  it("leaves a truncated preview out of the cache", async () => {
    const h = displayHarness();
    h.mt.auto = () => "We compared last month's quote with";
    h.coordinator.schedule(run(40));
    await h.coordinator.inFlight;
    expect(h.cache.has(sent(40))).toBe(false);
    expect(partials(h.events).at(-1)?.complete).toBe(false);
  });

  it("shows nothing for an empty result and caches nothing", async () => {
    const h = displayHarness();
    h.mt.auto = () => "";
    h.coordinator.schedule(run(20));
    await h.coordinator.inFlight;
    expect(partials(h.events)).toEqual([]);
    expect(h.cache.has(sent(20))).toBe(false);
  });

  it("drops a preview the worker skipped, and offers nothing", async () => {
    const h = displayHarness();
    h.coordinator.schedule(run(20));
    await settle();
    h.mt.previews()[0]?.skip();
    await h.coordinator.inFlight;
    expect(partials(h.events)).toEqual([]);
  });
});

describe("when the final preempts", () => {
  it("aborts the preview on the GPU, so the final does not queue behind it", async () => {
    const h = displayHarness();
    h.coordinator.schedule(run(20));
    await settle();
    const call = h.mt.previews()[0]!;
    h.coordinator.cancel();
    await h.coordinator.inFlight;
    expect(call.cancelled).toBe(true);
    expect(h.gpu.snapshot().running).toBeNull();
  });

  it("drops tokens and the result of a preview the final has overtaken", async () => {
    const h = displayHarness();
    h.coordinator.schedule(run(20));
    await settle();
    const stale = h.mt.previews()[0]!;
    h.coordinator.cancel();
    stale.finish("Too late.");
    await h.coordinator.inFlight;
    expect(partials(h.events)).toEqual([]);
    expect(h.cache.has(sent(20))).toBe(false);
  });

  it("starts no preview between the final starting and the utterance being reset", async () => {
    const h = displayHarness();
    h.coordinator.cancel();
    h.coordinator.schedule(run(30));
    expect(h.mt.previews()).toHaveLength(0);
    h.coordinator.resetUtterance();
    h.coordinator.schedule(run(30));
    await settle();
    expect(h.mt.previews()).toHaveLength(1);
  });
});

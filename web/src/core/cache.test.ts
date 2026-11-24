import { describe, expect, it } from "vitest";
import { fixtureCases, named } from "../test/fixtures";
import { STOCK_PHRASES, TRANSLATION_CACHE_MAX, TranslationCache, jaCacheKey, translationCacheKey } from "./cache";
import { asEnText, asJaText } from "./types";

type Pairs = readonly (readonly [string, string])[];
type Op =
  | { op: "reset" }
  | { op: "get"; ja: string }
  | { op: "preview"; ja: string; en: string }
  | { op: "final"; ja: string; en: string };

describe("translationCacheKey", () => {
  it.each(named(fixtureCases<string, string>("cache", "cache_key")))("%s", (_name, c) => {
    expect(translationCacheKey(c.input)).toBe(c.output);
  });
});

describe("jaCacheKey", () => {
  const cases = fixtureCases<{ ja: string; glossary: Pairs }, string>("cache", "pipeline_cache_key");

  it.each(named(cases))("%s", (_name, c) => {
    expect(jaCacheKey(asJaText(c.input.ja), new Map(c.input.glossary))).toBe(c.output);
  });
});

describe("STOCK_PHRASES", () => {
  it("match the recorded seeds", () => {
    const recorded = fixtureCases<string, string>("cache", "seeds").map((c) => [c.input, c.output]);
    expect([...STOCK_PHRASES].sort(([a], [b]) => (a < b ? -1 : 1))).toEqual(recorded);
  });

  it("cap matches the recorded size", () => {
    const [recorded] = fixtureCases<null, number>("cache", "max_entries");
    expect(TRANSLATION_CACHE_MAX).toBe(recorded?.output);
  });
});

describe("TranslationCache", () => {
  const cases = fixtureCases<Op[], { gets: (string | null)[]; entries: [string, string][] }>(
    "cache",
    "scenario",
  ) as readonly { name: string; input: Op[]; output: { gets: (string | null)[]; entries: [string, string][] } }[];

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const cache = new TranslationCache();
    const gets: (string | null)[] = [];
    for (const step of c.input) {
      if (step.op === "reset") cache.reset();
      else if (step.op === "get") gets.push(cache.lookup(asJaText(step.ja)) ?? null);
      else if (step.op === "preview") cache.storePreview(asJaText(step.ja), asEnText(step.en));
      else cache.storeFinal(asJaText(step.ja), asEnText(step.en));
    }
    expect({ gets, entries: cache.entries() }).toEqual(c.output);
  });

  it("reports a cached preview by key regardless of whitespace", () => {
    const cache = new TranslationCache();
    cache.storePreview(asJaText("部長には 報告しました。"), asEnText("I reported."));
    expect(cache.has(asJaText("部長には報告しました。"))).toBe(true);
    expect(cache.has(asJaText("別の文です。"))).toBe(false);
  });
});

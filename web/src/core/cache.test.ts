import { describe, expect, it } from "vitest";
import { fixtureCases } from "../test/fixtures";
import { translationCacheKey } from "./cache";

describe("translationCacheKey", () => {
  const cases = fixtureCases<string, string>("cache", "cache_key");

  it.each(cases.map((c) => [JSON.stringify(c.input), c] as const))("%s", (_name, c) => {
    expect(translationCacheKey(c.input)).toBe(c.output);
  });
});

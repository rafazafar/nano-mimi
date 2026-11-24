import { describe, expect, it } from "vitest";
import { fixtureCases, named } from "../test/fixtures";
import { deduplicatePhrases, isMostlyEnglish, isNonContentAsr, normalizePunctuation } from "./text";
import { asJaText } from "./types";

describe("normalizePunctuation", () => {
  it.each(named(fixtureCases<string, string>("text", "normalize_punctuation")))("%s", (_name, c) => {
    expect(normalizePunctuation(asJaText(c.input))).toBe(c.output);
  });
});

describe("isNonContentAsr", () => {
  it.each(named(fixtureCases<string, boolean>("text", "is_non_content_asr")))("%s", (_name, c) => {
    expect(isNonContentAsr(asJaText(c.input))).toBe(c.output);
  });
});

describe("deduplicatePhrases", () => {
  it.each(named(fixtureCases<string, string>("text", "deduplicate_phrases")))("%s", (_name, c) => {
    expect(deduplicatePhrases(asJaText(c.input))).toBe(c.output);
  });
});

describe("isMostlyEnglish", () => {
  it.each(named(fixtureCases<string, boolean>("text", "is_mostly_english")))("%s", (_name, c) => {
    expect(isMostlyEnglish(asJaText(c.input))).toBe(c.output);
  });
});

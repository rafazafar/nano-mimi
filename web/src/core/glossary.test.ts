import { describe, expect, it } from "vitest";
import { fixtureCases, named } from "../test/fixtures";
import { applyGlossary, isAsrFix, termSources } from "./glossary";
import { asJaText } from "./types";

type Pairs = readonly (readonly [string, string])[];

describe("applyGlossary", () => {
  const cases = fixtureCases<{ text: string; glossary: Pairs }, string>("glossary", "apply_glossary");

  it.each(named(cases))("%s", (_name, c) => {
    expect(applyGlossary(asJaText(c.input.text), new Map(c.input.glossary))).toBe(c.output);
  });
});

describe("isAsrFix", () => {
  it.each(named(fixtureCases<string, boolean>("glossary", "is_asr_fix")))("%s", (_name, c) => {
    expect(isAsrFix(c.input)).toBe(c.output);
  });
});

describe("termSources", () => {
  it.each(named(fixtureCases<Pairs, string[]>("glossary", "term_sources")))("%s", (_name, c) => {
    expect(termSources(new Map(c.input))).toEqual(c.output);
  });
});

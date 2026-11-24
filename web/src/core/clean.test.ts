import { describe, expect, it } from "vitest";
import { contextTurns, fixtureCases, named } from "../test/fixtures";
import { PROMPT_LEAK_MARKERS, cleanCat, echoesContext, isLabelled, tooShort } from "./clean";
import { asEnText, asJaText } from "./types";

type Pairs = readonly (readonly [string, string])[];

describe("cleanCat", () => {
  const cases = fixtureCases<
    string,
    { text: string; prompt_leak: boolean; japanese_stripped: boolean }
  >("clean", "clean_cat");

  it.each(named(cases))("%s", (_name, c) => {
    const cleaned = cleanCat(c.input);
    expect({
      text: cleaned.text,
      prompt_leak: cleaned.promptLeak,
      japanese_stripped: cleaned.japaneseStripped,
    }).toEqual(c.output);
  });
});

describe("echoesContext", () => {
  const cases = fixtureCases<{ en: string; context: Pairs; ja: string }, boolean>(
    "clean",
    "echoes_context",
  );

  it.each(named(cases))("%s", (_name, c) => {
    const { en, context, ja } = c.input;
    expect(echoesContext(asEnText(en), contextTurns(context), asJaText(ja))).toBe(c.output);
  });
});

describe("tooShort", () => {
  it.each(named(fixtureCases<{ en: string; ja: string }, boolean>("clean", "too_short")))(
    "%s",
    (_name, c) => {
      expect(tooShort(asEnText(c.input.en), asJaText(c.input.ja))).toBe(c.output);
    },
  );
});

describe("isLabelled", () => {
  it.each(named(fixtureCases<string, boolean>("clean", "labelled")))("%s", (_name, c) => {
    expect(isLabelled(c.input)).toBe(c.output);
  });
});

describe("PROMPT_LEAK_MARKERS", () => {
  it("match the recorded list", () => {
    const [recorded] = fixtureCases<null, string[]>("clean", "prompt_leak_markers");
    expect(PROMPT_LEAK_MARKERS).toEqual(recorded?.output);
  });
});

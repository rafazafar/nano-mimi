import { describe, expect, it } from "vitest";
import { fixtureCases, named } from "../test/fixtures";
import { groupDigits, unsupportedNumbers } from "./numbers";
import { asEnText, asJaText } from "./types";

describe("unsupportedNumbers", () => {
  const cases = fixtureCases<{ ja: string; en: string }, string[]>("numbers", "unsupported_numbers");

  it.each(named(cases))("%s", (_name, c) => {
    expect(unsupportedNumbers(asJaText(c.input.ja), asEnText(c.input.en))).toEqual(c.output);
  });
});

describe("groupDigits", () => {
  it.each(named(fixtureCases<string, string>("numbers", "group_digits")))("%s", (_name, c) => {
    expect(groupDigits(asJaText(c.input))).toBe(c.output);
  });
});

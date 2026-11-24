import { describe, expect, it } from "vitest";
import { fixtureCases, named } from "../test/fixtures";
import { japaneseTokenIds } from "./tokens";

describe("japaneseTokenIds", () => {
  const cases = fixtureCases<Record<string, number>, number[]>("tokens", "japanese_token_ids");

  it.each(named(cases))("%s", (_name, c) => {
    expect(japaneseTokenIds(new Map(Object.entries(c.input)))).toEqual(c.output);
  });
});

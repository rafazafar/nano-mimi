import { describe, expect, it } from "vitest";
import { fixtureCases, named } from "../test/fixtures";
import {
  REVISION_MAX_GAP_S,
  REVISION_MAX_JOINED_CHARS,
  endsMidSentence,
  isSplitContinuation,
} from "./revision";
import { asJaText } from "./types";

describe("endsMidSentence", () => {
  it.each(named(fixtureCases<string, boolean>("revision", "ends_mid_sentence")))("%s", (_name, c) => {
    expect(endsMidSentence(asJaText(c.input))).toBe(c.output);
  });
});

describe("isSplitContinuation", () => {
  const cases = fixtureCases<{ prev: string; next: string; gap_s: number }, boolean>(
    "revision",
    "is_split_continuation",
  );

  it.each(named(cases))("%s", (_name, c) => {
    const { prev, next, gap_s } = c.input;
    expect(isSplitContinuation(asJaText(prev), asJaText(next), gap_s)).toBe(c.output);
  });
});

describe("limits", () => {
  it("match the recorded constants", () => {
    const [limits] = fixtureCases<null, { max_gap_s: number; max_joined_chars: number }>(
      "revision",
      "limits",
    );
    expect({ max_gap_s: REVISION_MAX_GAP_S, max_joined_chars: REVISION_MAX_JOINED_CHARS }).toEqual(
      limits?.output,
    );
  });
});

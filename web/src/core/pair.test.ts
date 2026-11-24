import { describe, expect, it } from "vitest";
import { defaultPair, parsePair } from "./pair";

describe("pair", () => {
  it("defaults Japanese browsers to English speech with Japanese captions", () => {
    expect(defaultPair(["ja-JP", "en-US"])).toBe("en-ja");
    expect(defaultPair(["ja"])).toBe("en-ja");
  });

  it("defaults everyone else to Japanese speech with English captions", () => {
    expect(defaultPair(["en-US", "ja-JP"])).toBe("ja-en");
    expect(defaultPair(["jam"])).toBe("ja-en");
    expect(defaultPair([])).toBe("ja-en");
  });

  it("accepts only the two known pairs from storage", () => {
    expect(parsePair("en-ja")).toBe("en-ja");
    expect(parsePair("ja-en")).toBe("ja-en");
    expect(parsePair("zh-en")).toBeNull();
    expect(parsePair(null)).toBeNull();
  });
});

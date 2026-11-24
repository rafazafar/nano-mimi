import { describe, expect, it } from "vitest";
import { joinJapanese } from "./builtin";

describe("joinJapanese", () => {
  it("drops the spaces Chrome puts between Japanese words and keeps those around Latin words", () => {
    expect(joinJapanese("また 国連 で は 地球 温暖 化 の 影響")).toBe("また国連では地球温暖化の影響");
    expect(joinJapanese("今日 は Google Chrome で テスト")).toBe("今日は Google Chrome でテスト");
    expect(joinJapanese("カタカナー 々 漢字")).toBe("カタカナー々漢字");
  });
});

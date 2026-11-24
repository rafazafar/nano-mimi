import { describe, expect, it } from "vitest";
import { chatMessages } from "./prompt";
import { strategyFor } from "./strategy";
import { applyEnglishGlossary } from "./glossary";
import { cleanCatEnJa } from "./clean";
import { normalizeEnglishPunctuation, normalizePunctuation } from "./text";
import { asEnText, asJaText } from "./types";

const en = strategyFor("en-ja");
const ja = strategyFor("ja-en");
const src = asJaText;

describe("en-ja prompt", () => {
  it("uses CAT's official prompt, and the same template for context turns", () => {
    const { messages } = chatMessages(src("See you tomorrow."), [{ ja: src("Thank you."), en: asEnText("ありがとう。") }], en.translate.prompt);
    expect(messages).toEqual([
      { role: "user", content: "Translate the following English text into Japanese.\n\nThank you." },
      { role: "assistant", content: "ありがとう。" },
      { role: "user", content: "Translate the following English text into Japanese.\n\nSee you tomorrow." },
    ]);
  });

  it("scales the token cap with source length, between 32 and 192", () => {
    const cap = (n: number) => en.translate.prompt(src("a".repeat(n))).maxTokens;
    expect([cap(5), cap(130), cap(200), cap(2000)]).toEqual([32, 89, 124, 192]);
  });

  it("leaves ja-en prompts alone", () => {
    expect(ja.translate.prompt(src("はい。")).prompt).toBe("Japanese: はい。\nEnglish:");
  });
});

describe("en-ja cleaning", () => {
  it("keeps Japanese and its punctuation", () => {
    expect(cleanCatEnJa("明日、会議で話します。").text).toBe("明日、会議で話します。");
  });

  it.each(["Japanese: こんにちは。", "日本語: こんにちは。", "翻訳：こんにちは。", "Japanese translation: こんにちは。"])(
    "drops the leading label in %s",
    (raw) => {
      expect(cleanCatEnJa(raw).text).toBe("こんにちは。");
    },
  );

  it("cuts leaked prompt text and reports it", () => {
    const cleaned = cleanCatEnJa("こんにちは。\n\nTranslate the following English text into Japanese.\n\nHello.");
    expect(cleaned).toMatchObject({ text: "こんにちは。", promptLeak: true, japaneseStripped: false });
  });

  it("keeps quoted English that only resembles the prompt", () => {
    expect(cleanCatEnJa("ボタンには「Translate this」と書かれています。").text).toBe("ボタンには「Translate this」と書かれています。");
  });

  it("joins lines without spaces inside Japanese", () => {
    expect(cleanCatEnJa("今日は\n晴れです。").text).toBe("今日は晴れです。");
  });
});

describe("en-ja retry rule", () => {
  const turns = [{ ja: src("Thanks for the report."), en: asEnText("報告ありがとう。") }];
  const retry = (out: string, text: string) =>
    en.translate.retryWithoutContext({ en: asEnText(out), raw: out }, turns, src(text));

  it("retries on an empty reply or a copied context line, not on a fresh translation", () => {
    expect(retry("", "Next item.")).toBe(true);
    expect(retry("報告ありがとう。", "Next item.")).toBe(true);
    expect(retry("次の項目です。", "Next item.")).toBe(false);
  });

  it("allows a repeat when the source repeats too", () => {
    expect(retry("報告ありがとう。", "Thanks for the report!")).toBe(false);
  });

  it("does not check numbers", () => {
    expect(en.translate.numbers).toBeNull();
    expect(ja.translate.numbers).not.toBeNull();
  });
});

describe("pair-dependent source handling", () => {
  it("only ja-en bans Japanese tokens", () => {
    expect([ja.translate.banSourceScript, en.translate.banSourceScript]).toEqual([true, false]);
  });

  it("closes an English line with a full stop, not a Japanese one", () => {
    expect(normalizeEnglishPunctuation(src("See you tomorrow"))).toBe("See you tomorrow.");
    expect(normalizeEnglishPunctuation(src("Really?"))).toBe("Really?");
    expect(en.source.normalizePunctuation(src("Hi"))).toBe("Hi.");
    expect(normalizePunctuation(src("はい"))).toBe("はい。");
  });

  it("never treats English source as a passthrough, and never sends it as context", () => {
    expect(en.source.passthrough(src("Thank you very much."))).toBe(false);
    expect(en.source.contextEligible(src("Thank you very much."))).toBe(false);
    expect(ja.source.passthrough(src("Thank you very much."))).toBe(true);
  });

  it("turns off preview and split repair for en-ja only", () => {
    expect([en.preview, en.splitRepair, ja.preview, ja.splitRepair]).toEqual([false, false, true, true]);
  });
});

describe("applyEnglishGlossary", () => {
  const glossary = new Map([
    ["Kubernetes", "クバネティス"],
    ["Mimi Vox", "ミミボックス"],
    ["API", "エーピーアイ"],
    ["見積もり", "quote"],
  ]);

  it("substitutes whole words, ignoring case", () => {
    expect(applyEnglishGlossary(src("We run kubernetes and an api."), glossary)).toBe("We run クバネティス and an エーピーアイ.");
  });

  it("leaves partial words alone", () => {
    expect(applyEnglishGlossary(src("The rapid apiary."), glossary)).toBe("The rapid apiary.");
  });

  it("matches multi-word terms and skips entries with a Japanese source", () => {
    expect(applyEnglishGlossary(src("Try mimi vox, 見積もり."), glossary)).toBe("Try ミミボックス, 見積もり.");
  });

  it("treats regex characters in a term literally", () => {
    expect(applyEnglishGlossary(src("Use C++ today."), new Map([["C++", "シープラプラ"]]))).toBe("Use シープラプラ today.");
  });
});

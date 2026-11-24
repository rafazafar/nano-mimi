import { describe, expect, it } from "vitest";
import { fixtureCases, named } from "../test/fixtures";
import { CONTEXT_TURNS, TranslationContext } from "./context";
import { asEnText, asJaText } from "./types";

type Pairs = readonly (readonly [string, string])[];

function after(adds: Pairs): string[][] {
  const context = new TranslationContext();
  for (const [ja, en] of adds) context.add(asJaText(ja), asEnText(en));
  return context.pairs().map((turn) => [turn.ja, turn.en]);
}

describe("TranslationContext", () => {
  it.each(named(fixtureCases<Pairs, string[][]>("context", "translation_context")))("%s", (_name, c) => {
    expect(after(c.input)).toEqual(c.output);
  });

  it("restores an earlier snapshot, dropping lines added since", () => {
    const context = new TranslationContext();
    context.add(asJaText("最初の長い文章です。"), asEnText("first"));
    const snapshot = context.pairs();
    context.add(asJaText("二番目の長い文章です。"), asEnText("second"));
    context.restore(snapshot);
    expect(context.pairs()).toEqual(snapshot);
  });

  it("keeps the last window when restored from a longer list", () => {
    const context = new TranslationContext();
    const turns = ["一", "二", "三", "四"].map((n) => ({
      ja: asJaText(`${n}番目の長い文章です。`),
      en: asEnText(n),
    }));
    context.restore(turns);
    expect(context.pairs()).toEqual(turns.slice(1));
  });
});

describe("CONTEXT_TURNS", () => {
  it("matches the recorded window size", () => {
    const [recorded] = fixtureCases<null, number>("context", "context_turns");
    expect(CONTEXT_TURNS).toBe(recorded?.output);
  });
});

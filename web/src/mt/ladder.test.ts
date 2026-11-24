import { describe, expect, it } from "vitest";
import { asEnText, asJaText, type ContextTurn } from "../core/types";
import { PREVIEW_MAX_TOKENS, translateWithRetries, type Generate, type GenerateRequest } from "./ladder";

const turn = (ja: string, en: string): ContextTurn => ({ ja: asJaText(ja), en: asEnText(en) });

/** Replays scripted raw outputs in order and records every request. */
function scripted(...answers: string[]): { generate: Generate; requests: GenerateRequest[]; streamed: boolean[] } {
  const requests: GenerateRequest[] = [];
  const streamed: boolean[] = [];
  const generate: Generate = async (request, onToken, signal) => {
    signal.throwIfAborted();
    requests.push(request);
    streamed.push(onToken !== null);
    const raw = answers[requests.length - 1];
    if (raw === undefined) throw new Error(`no scripted answer for call ${requests.length}`);
    for (const word of raw.split(/(?<= )/)) onToken?.(word);
    return { raw, tokens: raw.split(" ").length, ms: 1, ttftMs: 1, decodeTps: null };
  };
  return { generate, requests, streamed };
}

const options = { preview: false, signal: new AbortController().signal, onToken: null };

describe("translateWithRetries", () => {
  it("sends context as prior chat turns", async () => {
    const fake = scripted("We will talk about it");
    const result = await translateWithRetries(asJaText("明日話すつもりです。"), [turn("まだです。", "Not yet")], fake.generate, options);
    expect(result.en).toBe("We will talk about it");
    expect(fake.requests[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(result.attempts.map((a) => a.reason)).toEqual(["first"]);
  });

  it("retranslates without context when the reply echoes a prior line", async () => {
    const fake = scripted("Thank you. I will prepare the document", "Thank you. I look forward to working with you");
    const result = await translateWithRetries(
      asJaText("ありがとうございます。よろしくお願いします。"),
      [turn("資料は私が準備します。", "Understood. I will prepare the document")],
      fake.generate,
      options,
    );
    expect(result.en).toBe("Thank you. I look forward to working with you");
    expect(fake.requests.map((r) => r.messages.length)).toEqual([3, 1]);
    expect(result.attempts.map((a) => a.reason)).toEqual(["first", "no-context"]);
    expect(result.kept).toBe(1);
  });

  it("retranslates without context when cleaning leaves nothing (Japanese-only reply)", async () => {
    const fake = scripted("よろしくお願いいたします。", "We look forward to working with you");
    const result = await translateWithRetries(
      asJaText("ありがとうございます、I look forward to working with you。"),
      [turn("資料は私が準備します。", "I will prepare the document")],
      fake.generate,
      options,
    );
    expect(result.en).toBe("We look forward to working with you");
    expect(result.attempts[0]!.en).toBe("");
  });

  it("retries a label-prefixed reply without context", async () => {
    const fake = scripted(
      "Translation: From the palace, we were forced to return to Paris",
      "They were forced to return from the palace to Paris",
    );
    const result = await translateWithRetries(
      asJaText("宮殿からパリへと強制的に戻されました。"),
      [turn("市場の女性たちによって、", "by the women of the market")],
      fake.generate,
      options,
    );
    expect(result.en).toBe("They were forced to return from the palace to Paris");
    expect(fake.requests.map((r) => r.messages.length)).toEqual([3, 1]);
  });

  it("retries a too-short reply without context", async () => {
    const longJa =
      "募集とかもそちらの方でお願いしたいなと思ってますので、私的には本当に開催できれば" +
      "本当にありがたいので、どういう形でも人数でも構いませんので、お願いしたいなと思っております。";
    const fake = scripted("Is that clear?", "We would like you to handle recruitment too, in any format.");
    const result = await translateWithRetries(asJaText(longJa), [turn("ですかね、本当にそうですか。", "Is that clear?")], fake.generate, options);
    expect(result.attempts.map((a) => a.reason)).toEqual(["first", "no-context"]);
    expect(result.en).toBe("We would like you to handle recruitment too, in any format");
  });

  it("never retries without context when there was no context", async () => {
    const fake = scripted("よろしくお願いいたします。");
    const result = await translateWithRetries(asJaText("よろしくお願いします。"), [], fake.generate, options);
    expect(result.en).toBe("");
    expect(fake.requests).toHaveLength(1);
  });

  it("retranslates a wrong number with grouped digits and keeps the better reply", async () => {
    const fake = scripted("Japan has about 70,000 islands", "Japan has about 7,000 islands");
    const result = await translateWithRetries(asJaText("日本には約7000の島々があります。"), [], fake.generate, options);
    expect(result.en).toBe("Japan has about 7,000 islands");
    expect(fake.requests[1]!.messages.at(-1)!.content).toContain("約7,000の島々");
    expect(result.numbersMismatch).toBe(false);
    expect(result.attempts.map((a) => a.reason)).toEqual(["first", "grouped-digits"]);
    expect(result.kept).toBe(1);
  });

  it("keeps the first reply when the grouped retry is no better, and flags it", async () => {
    const fake = scripted("Japan has about 70,000 islands", "Japan has 70,000 islands");
    const result = await translateWithRetries(asJaText("日本には約7000の島々があります。"), [], fake.generate, options);
    expect(result.en).toBe("Japan has about 70,000 islands");
    expect(result.numbersMismatch).toBe(true);
    expect(result.kept).toBe(0);
  });

  it("costs no retry when numbers match", async () => {
    const fake = scripted("The price is 20 percent higher than last month");
    const result = await translateWithRetries(asJaText("先月より二割高いですね。"), [], fake.generate, options);
    expect(result.en).toBe("The price is 20 percent higher than last month");
    expect(fake.requests).toHaveLength(1);
  });

  it("skips the grouped retry when grouping changes nothing and there is no context", async () => {
    const fake = scripted("It was 1999 or 2000");
    const result = await translateWithRetries(asJaText("それは三年前でした。"), [], fake.generate, options);
    expect(fake.requests).toHaveLength(1);
    expect(result.numbersMismatch).toBe(true);
  });

  it("streams only the first pass", async () => {
    const fake = scripted("Japan has about 70,000 islands", "Japan has about 7,000 islands");
    const deltas: string[] = [];
    await translateWithRetries(asJaText("日本には約7000の島々があります。"), [], fake.generate, {
      ...options,
      onToken: (d) => deltas.push(d),
    });
    expect(fake.streamed).toEqual([true, false]);
    expect(deltas.join("")).toBe("Japan has about 70,000 islands");
  });

  it("uses the bucket's max_tokens, capped at 48 for previews", async () => {
    const longJa = asJaText("あ".repeat(100));
    const final = scripted("x y z");
    await translateWithRetries(longJa, [], final.generate, options);
    expect(final.requests[0]!.maxTokens).toBe(116);
    const preview = scripted("x y z");
    await translateWithRetries(longJa, [], preview.generate, { ...options, preview: true });
    expect(preview.requests[0]!.maxTokens).toBe(PREVIEW_MAX_TOKENS);
    const short = scripted("x y");
    await translateWithRetries(asJaText("はい"), [], short.generate, { ...options, preview: true });
    expect(short.requests[0]!.maxTokens).toBe(16);
  });

  it("stops the ladder when aborted mid-way", async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const generate: Generate = async (_r, _t, signal) => {
      calls++;
      ctrl.abort();
      signal.throwIfAborted();
      return { raw: "Japan has about 70,000 islands", tokens: 5, ms: 1, ttftMs: 1, decodeTps: null };
    };
    await expect(
      translateWithRetries(asJaText("日本には約7000の島々があります。"), [], generate, { ...options, signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("cleans with the core cleaner, including the new leak markers", async () => {
    const fake = scripted("The police arrived at the scene. Avoid using overly formal and literal wording.");
    const result = await translateWithRetries(asJaText("警察が現場に到着しました。"), [], fake.generate, options);
    expect(result.en).toBe("The police arrived at the scene");
    expect(result.promptLeak).toBe(true);
  });
});

describe("translateWithRetries for en-ja", () => {
  const enJa = { ...options, pair: "en-ja" as const };

  it("asks for Japanese with the official prompt, unbanned, and keeps Japanese output", async () => {
    const fake = scripted("明日話します。");
    const result = await translateWithRetries(asJaText("We will talk tomorrow."), [], fake.generate, enJa);
    expect(result.en).toBe("明日話します。");
    expect(fake.requests[0]).toMatchObject({
      messages: [{ role: "user", content: "Translate the following English text into Japanese.\n\nWe will talk tomorrow." }],
      banSourceScript: false,
    });
  });

  it("bans the Japanese script for ja-en only", async () => {
    const fake = scripted("Yes");
    await translateWithRetries(asJaText("はい。"), [], fake.generate, options);
    expect(fake.requests[0]?.banSourceScript).toBe(true);
  });

  it("retranslates without context when the reply echoes a context line", async () => {
    const fake = scripted("報告ありがとう。", "次の項目です。");
    const result = await translateWithRetries(
      asJaText("Next item."),
      [turn("Thanks for the report.", "報告ありがとう。")],
      fake.generate,
      enJa,
    );
    expect(result.en).toBe("次の項目です。");
    expect(result.attempts.map((a) => a.reason)).toEqual(["first", "no-context"]);
  });

  it("does not retry over numbers", async () => {
    const fake = scripted("会議は三時です。");
    const result = await translateWithRetries(asJaText("The meeting is at 3 PM."), [], fake.generate, enJa);
    expect(result.attempts).toHaveLength(1);
    expect(result.numbersMismatch).toBe(false);
  });

  it("applies the preview cap", async () => {
    const fake = scripted("あ");
    await translateWithRetries(asJaText("a".repeat(400)), [], fake.generate, { ...enJa, preview: true });
    expect(fake.requests[0]?.maxTokens).toBe(PREVIEW_MAX_TOKENS);
  });
});

import { describe, expect, it } from "vitest";
import { contextTurns, fixtureCases, named } from "../test/fixtures";
import {
  LONG_PHRASE_PROMPT,
  SHORT_PHRASE_PROMPT,
  ULTRA_SHORT_PROMPT,
  chatMessages,
  promptAndTokens,
} from "./prompt";
import { asJaText } from "./types";

type Pairs = readonly (readonly [string, string])[];

describe("promptAndTokens", () => {
  const cases = fixtureCases<string, { prompt: string; max_tokens: number }>(
    "prompt",
    "prompt_and_tokens",
  );

  it.each(named(cases))("%s", (_name, c) => {
    const { prompt, maxTokens } = promptAndTokens(asJaText(c.input));
    expect({ prompt, max_tokens: maxTokens }).toEqual(c.output);
  });
});

// The recorded `prompt` field is the tokenizer's rendering of `messages`; rendering is not ported here.
describe("chatMessages", () => {
  const cases = fixtureCases<
    { ja: string; context: Pairs },
    { messages: { role: string; content: string }[]; max_tokens: number }
  >("prompt", "chat_messages");

  it.each(named(cases))("%s", (_name, c) => {
    const { messages, maxTokens } = chatMessages(asJaText(c.input.ja), contextTurns(c.input.context));
    expect({ messages, max_tokens: maxTokens }).toEqual({
      messages: c.output.messages,
      max_tokens: c.output.max_tokens,
    });
  });
});

describe("templates", () => {
  it("match the recorded strings", () => {
    const [recorded] = fixtureCases<null, Record<string, string>>("prompt", "templates");
    expect({
      ultra_short: ULTRA_SHORT_PROMPT,
      short_phrase: SHORT_PHRASE_PROMPT,
      long_phrase: LONG_PHRASE_PROMPT,
    }).toEqual(recorded?.output);
  });
});

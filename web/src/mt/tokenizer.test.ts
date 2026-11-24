import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AutoTokenizer, env } from "@huggingface/transformers";
import { beforeAll, describe, expect, it } from "vitest";
import { chatMessages } from "../core/prompt";
import { asJaText } from "../core/types";
import { CAT_MODEL } from "../models/manifest";
import { contextTurns, fixtureCases, named, readFixture, type FixtureCase } from "../test/fixtures";
import { CatTokenizer, type TjsTokenizer } from "./tokenizer";

/** A local copy of the CAT model dir (only the tokenizer files are read here). */
const MODEL_DIR = process.env["MIMIVOX_CAT_DIR"] ?? join(homedir(), ".cache/mimivox/web-models/cat-ogb-q4");
const TOKENIZER_JSON = join(MODEL_DIR, "tokenizer.json");

type Pairs = readonly (readonly [string, string])[];
type ChatCase = FixtureCase<{ ja: string; context: Pairs }, { prompt: string; max_tokens: number }>;
type IdsCase = FixtureCase<{ ja: string; context: Pairs }, { prompt: string; input_ids: number[] }>;

interface PromptIdsFile {
  readonly functions: { readonly prompt_ids: readonly IdsCase[] };
  readonly cat: { readonly eos_token_id: number };
}

describe.skipIf(!existsSync(TOKENIZER_JSON))(`CAT tokenizer parity (needs ${MODEL_DIR})`, () => {
  let tok: CatTokenizer;
  let raw: TjsTokenizer;
  const idsFile = readFixture<PromptIdsFile>("mt/prompt_ids.json");

  beforeAll(async () => {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = `${join(MODEL_DIR, "..")}/`;
    raw = (await AutoTokenizer.from_pretrained(MODEL_DIR.split("/").at(-1)!)) as unknown as TjsTokenizer;
    tok = new CatTokenizer(raw, idsFile.cat.eos_token_id);
  });

  it("reads the tokenizer the manifest ships", () => {
    for (const name of ["tokenizer.json", "tokenizer_config.json"]) {
      const spec = CAT_MODEL.files.find((f) => f.path === name)!;
      expect(createHash("sha256").update(readFileSync(join(MODEL_DIR, name))).digest("hex")).toBe(spec.sha256);
    }
  });

  describe("rendered prompt is byte-identical to Python", () => {
    it.each(named(fixtureCases<ChatCase["input"], ChatCase["output"]>("prompt", "chat_messages")))("%s", (_n, c) => {
      const { messages } = chatMessages(asJaText(c.input.ja), contextTurns(c.input.context));
      expect(tok.render(messages)).toBe(c.output.prompt);
    });
  });

  describe("prompt token ids match Python", () => {
    it.each(named(idsFile.functions.prompt_ids))("%s", (_n, c) => {
      const { messages } = chatMessages(asJaText(c.input.ja), contextTurns(c.input.context));
      const prompt = tok.render(messages);
      expect(prompt).toBe(c.output.prompt);
      expect(tok.encode(prompt)).toEqual(c.output.input_ids);
    });
  });

  it("needs byte fallback: plain transformers.js encoding differs on some prompts", () => {
    const differ = idsFile.functions.prompt_ids.filter(
      (c) => JSON.stringify(raw.encode(c.output.prompt, { add_special_tokens: false })) !== JSON.stringify(c.output.input_ids),
    );
    expect(differ.length).toBeGreaterThan(0);
  });

  it("bans the same Japanese-script ids as Python", () => {
    const tokens = readFixture<{ cat: { japanese_token_ids: number[]; vocab_size: number } }>("core/tokens.json");
    expect(raw.get_vocab().size).toBe(tokens.cat.vocab_size);
    expect([...tok.bannedIds]).toEqual(tokens.cat.japanese_token_ids);
  });
});

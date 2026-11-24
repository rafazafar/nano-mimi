import type { ChatMessage } from "../core/prompt";
import { japaneseTokenIds } from "../core/tokens";

/** The slice of a transformers.js tokenizer this module uses. */
export interface TjsTokenizer {
  encode(text: string, options: { add_special_tokens: boolean }): number[];
  decode(ids: readonly number[], options: { skip_special_tokens: boolean }): string;
  get_vocab(): Map<string, number>;
  apply_chat_template(
    messages: ChatMessage[],
    options: { tokenize: false; add_generation_prompt: true },
  ): string | unknown;
  readonly unk_token_id: number | null | undefined;
}

/**
 * CAT's tokenizer as the Python path runs it.
 *
 * CAT's SentencePiece model has `byte_fallback: true`: a character missing from
 * the vocab becomes its UTF-8 bytes as `<0xXX>` pieces. transformers.js ignores
 * that and emits `<unk>` instead (the `\n\n` in the long-phrase prompt, rare
 * kanji), so `encode` splits those characters out and spells their bytes itself.
 */
export class CatTokenizer {
  readonly bannedIds: Int32Array;
  readonly eosTokenId: number | null;
  private readonly byteIds: readonly number[];
  private readonly unkId: number;
  private readonly unknownChar = new Map<string, boolean>();

  constructor(private readonly tok: TjsTokenizer, eosTokenId: number | null) {
    const vocab = tok.get_vocab();
    this.byteIds = Array.from({ length: 256 }, (_, b) => {
      const id = vocab.get(`<0x${b.toString(16).toUpperCase().padStart(2, "0")}>`);
      if (id === undefined) throw new Error(`tokenizer has no byte piece for 0x${b.toString(16)}`);
      return id;
    });
    if (tok.unk_token_id === null || tok.unk_token_id === undefined) throw new Error("tokenizer has no <unk> id");
    this.unkId = tok.unk_token_id;
    this.bannedIds = Int32Array.from(japaneseTokenIds(vocab));
    this.eosTokenId = eosTokenId;
  }

  /** The chat template rendered with the generation prompt, as `apply_chat_template(..., tokenize=False)`. */
  render(messages: readonly ChatMessage[]): string {
    const out = this.tok.apply_chat_template([...messages], { tokenize: false, add_generation_prompt: true });
    if (typeof out !== "string") throw new Error("chat template did not render to a string");
    return out;
  }

  /**
   * Token ids for a rendered prompt. CAT's template carries its own markers and
   * the Python tokenizer adds no specials to it, so none are added here.
   */
  encode(prompt: string): number[] {
    const ids: number[] = [];
    let run = "";
    const flush = (): void => {
      if (run !== "") ids.push(...this.tok.encode(run, { add_special_tokens: false }));
      run = "";
    };
    for (const ch of prompt) {
      if (!this.isUnknown(ch)) {
        run += ch;
        continue;
      }
      flush();
      for (const byte of new TextEncoder().encode(ch)) ids.push(this.byteIds[byte]!);
    }
    flush();
    return ids;
  }

  decode(ids: readonly number[]): string {
    return this.tok.decode(ids, { skip_special_tokens: true });
  }

  private isUnknown(ch: string): boolean {
    let unknown = this.unknownChar.get(ch);
    if (unknown === undefined) {
      unknown = this.tok.encode(ch, { add_special_tokens: false }).includes(this.unkId);
      this.unknownChar.set(ch, unknown);
    }
    return unknown;
  }
}

import { cleanCat, echoesContext, isLabelled, tooShort } from "../core/clean";
import { groupDigits, unsupportedNumbers } from "../core/numbers";
import { chatMessages, type ChatMessage } from "../core/prompt";
import type { ContextTurn, JaText } from "../core/types";
import type { Attempt, AttemptReason, Generation, MtResult } from "./protocol";

/** Previews are capped so a final never waits long behind one (translate.py `_PREVIEW_MAX_TOKENS`). */
export const PREVIEW_MAX_TOKENS = 48;

export interface GenerateRequest {
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
}

/** One greedy CAT pass. Must reject with an AbortError once `signal` fires. */
export type Generate = (
  request: GenerateRequest,
  onToken: ((delta: string) => void) | null,
  signal: AbortSignal,
) => Promise<Generation>;

export interface LadderOptions {
  readonly preview: boolean;
  readonly signal: AbortSignal;
  /** Receives the first pass's tokens only; retries run silently, as in translate.py. */
  readonly onToken: ((delta: string) => void) | null;
  readonly now?: () => number;
}

/**
 * Port of translate.py `_do_translate_streaming`: one pass with context, a
 * no-context retry when that reply is empty, an echo, too short or labelled,
 * and a grouped-digits retry when numbers do not match, keeping whichever
 * reply has fewer unsupported numbers.
 */
export async function translateWithRetries(
  ja: JaText,
  context: readonly ContextTurn[],
  generate: Generate,
  options: LadderOptions,
): Promise<MtResult> {
  const now = options.now ?? (() => performance.now());
  const t0 = now();
  const attempts: Attempt[] = [];

  const run = async (
    reason: AttemptReason,
    text: JaText,
    turns: readonly ContextTurn[],
    onToken: ((delta: string) => void) | null,
  ): Promise<{ attempt: Attempt; promptLeak: boolean; japaneseStripped: boolean }> => {
    const { messages, maxTokens } = chatMessages(text, turns);
    const cap = options.preview ? Math.min(maxTokens, PREVIEW_MAX_TOKENS) : maxTokens;
    const generation = await generate({ messages, maxTokens: cap }, onToken, options.signal);
    options.signal.throwIfAborted();
    const cleaned = cleanCat(generation.raw);
    const attempt: Attempt = { ...generation, reason, en: cleaned.text };
    attempts.push(attempt);
    return { attempt, promptLeak: cleaned.promptLeak, japaneseStripped: cleaned.japaneseStripped };
  };

  let turns = context;
  let best = await run("first", ja, turns, options.onToken);
  const first = best.attempt;
  if (
    turns.length > 0 &&
    (first.en === "" || echoesContext(first.en, turns, ja) || tooShort(first.en, ja) || isLabelled(first.raw))
  ) {
    turns = [];
    best = await run("no-context", ja, turns, null);
  }

  let wrong = unsupportedNumbers(ja, best.attempt.en);
  const grouped = groupDigits(ja);
  if (wrong.length > 0 && (turns.length > 0 || grouped !== ja)) {
    const retry = await run("grouped-digits", grouped, [], null);
    const retryWrong = unsupportedNumbers(ja, retry.attempt.en);
    if (retryWrong.length < wrong.length) {
      best = retry;
      wrong = retryWrong;
    }
  }

  return {
    en: best.attempt.en,
    raw: best.attempt.raw,
    promptLeak: best.promptLeak,
    japaneseStripped: best.japaneseStripped,
    numbersMismatch: wrong.length > 0,
    attempts,
    kept: attempts.indexOf(best.attempt),
    totalMs: now() - t0,
  };
}

import { cpLength, pyStrip } from "./text";
import type { ContextTurn, JaText } from "./types";

export const ULTRA_SHORT_PROMPT = "Japanese: {ja}\nEnglish:";
export const SHORT_PHRASE_PROMPT = "Translate this Japanese phrase to natural English: {ja}";
export const LONG_PHRASE_PROMPT =
  "Translate the following Japanese speech into natural conversational English. " +
  "Preserve the meaning, tone, and speaker intent; avoid stiff literal wording.\n\n{ja}";

export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface PromptChoice {
  readonly prompt: string;
  readonly maxTokens: number;
}

function fill(template: string, ja: string): string {
  return template.replace("{ja}", () => ja);
}

/** Pick the prompt and token cap by JA length: <=5, <=25, <=60 chars, then longer. */
export function promptAndTokens(ja: JaText): PromptChoice {
  const length = cpLength(pyStrip(ja));
  if (length <= 5) return { prompt: fill(ULTRA_SHORT_PROMPT, ja), maxTokens: 16 };
  if (length <= 25) return { prompt: fill(SHORT_PHRASE_PROMPT, ja), maxTokens: 32 };
  if (length <= 60) return { prompt: fill(LONG_PHRASE_PROMPT, ja), maxTokens: 64 };
  // Revision joins reach 120 chars and need about 0.75 tokens per JA char.
  return { prompt: fill(LONG_PHRASE_PROMPT, ja), maxTokens: Math.max(80, length + 16) };
}

/** CAT chat turns: each prior line as a user/assistant pair, then the current line. */
export function chatMessages(
  ja: JaText,
  context: readonly ContextTurn[],
): { messages: ChatMessage[]; maxTokens: number } {
  const messages: ChatMessage[] = context.flatMap((turn) => [
    { role: "user" as const, content: promptAndTokens(turn.ja).prompt },
    { role: "assistant" as const, content: turn.en },
  ]);
  const { prompt, maxTokens } = promptAndTokens(ja);
  messages.push({ role: "user", content: prompt });
  return { messages, maxTokens };
}

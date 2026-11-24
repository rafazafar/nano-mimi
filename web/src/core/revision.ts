import { cpLength, pyStrip, rstripChars } from "./text";
import type { JaText } from "./types";

export const REVISION_MAX_GAP_S = 1.5;
export const REVISION_MAX_JOINED_CHARS = 120;

const COMMAS = "、，,";
const CLOSERS = "」』）)\"'";
const MIN_UNPUNCTUATED_CHARS = 5;
// After 。 only conjunctions that cannot close a sentence count: "待って。" is a complete reply.
const STRONG_CONJUNCTIONS = ["けれども", "けれど", "けど", "ので", "が"];

/** True when the line looks like it stops before the sentence is finished. */
export function endsMidSentence(ja: JaText): boolean {
  const tail = rstripChars(pyStrip(ja), CLOSERS);
  if (tail === "") return false;
  const last = tail.slice(-1);
  if (COMMAS.includes(last)) return true;
  if ("？！?!".includes(last)) return false;
  if (last === "。") return STRONG_CONJUNCTIONS.some((word) => tail.slice(0, -1).endsWith(word));
  return cpLength(tail) >= MIN_UNPUNCTUATED_CHARS;
}

/** True when `next` continues `prev` across a VAD split; `gapS` is the silence between them. */
export function isSplitContinuation(prev: JaText, next: JaText, gapS: number): boolean {
  const prevText = pyStrip(prev);
  const nextText = pyStrip(next);
  if (prevText === "" || nextText === "") return false;
  if (gapS > REVISION_MAX_GAP_S) return false;
  if (cpLength(prevText) + cpLength(nextText) > REVISION_MAX_JOINED_CHARS) return false;
  return endsMidSentence(prev);
}

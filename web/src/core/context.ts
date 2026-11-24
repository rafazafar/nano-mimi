import { cpLength, isMostlyEnglish, jaContent, pyStrip } from "./text";
import type { ContextTurn, EnText, JaText } from "./types";
import { asEnText } from "./types";

export const CONTEXT_TURNS = 3;
const CONTEXT_MIN_CHARS = 6;

/** Rolling window of recent finished lines for one session. */
export class TranslationContext {
  #turns: ContextTurn[] = [];

  /**
   * Remember a finished line. Empty, fragment and English-passthrough lines are
   * skipped: a fragment such as ですかね gives CAT a short answer it copies onto
   * the next lines.
   */
  add(ja: JaText, en: EnText): void {
    const trimmed = pyStrip(en);
    if (trimmed === "" || cpLength(jaContent(ja)) < CONTEXT_MIN_CHARS || isMostlyEnglish(ja)) return;
    this.#turns.push({ ja, en: asEnText(trimmed) });
    if (this.#turns.length > CONTEXT_TURNS) this.#turns.shift();
  }

  pairs(): readonly ContextTurn[] {
    return [...this.#turns];
  }

  /** Roll back to an earlier `pairs()` snapshot, dropping lines added since. */
  restore(turns: readonly ContextTurn[]): void {
    this.#turns = turns.slice(-CONTEXT_TURNS);
  }
}

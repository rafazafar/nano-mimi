import type { Glossary } from "../core/glossary";
import { strategyFor, type PairStrategy } from "../core/strategy";
import type { JaText } from "../core/types";

/** A JA line as the pipeline sees it: `plain` to judge the text itself, `sent` for the cache and the translator. */
export interface Line {
  readonly plain: JaText;
  readonly sent: JaText;
}

/**
 * Closes the sentence, then substitutes the glossary. Previews and finals both go through here, so the cache
 * entry a preview seeds is the one the final looks up.
 */
export function prepareLine(text: JaText, glossary: Glossary, strategy: PairStrategy = strategyFor("ja-en")): Line {
  const plain = strategy.source.normalizePunctuation(text);
  return { plain, sent: strategy.source.applyGlossary(plain, glossary) };
}

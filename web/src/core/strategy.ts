import { cleanCat, cleanCatEnJa, echoesContext, echoesContextEnJa, isLabelled, tooShort, type CleanedCat } from "./clean";
import { applyEnglishGlossary, applyGlossary, type Glossary } from "./glossary";
import { groupDigits, unsupportedNumbers } from "./numbers";
import type { PairId } from "./pair";
import { enJaPromptAndTokens, promptAndTokens, type PromptChoice } from "./prompt";
import { cpLength, isMostlyEnglish, jaContent, normalizeEnglishPunctuation, normalizePunctuation } from "./text";
import { asJaText, type ContextTurn, type EnText, type JaText } from "./types";

/** How the source's numbers are checked against the translation, with the retry's rewrite of the source. */
export interface NumberCheck {
  unsupported(src: JaText, translation: EnText): string[];
  regroup(src: JaText): JaText;
}

/**
 * Everything that differs between translation directions. `src` is the recognized text (`JaText`) and the
 * translation is `EnText`, whichever languages they are.
 */
export interface PairStrategy {
  readonly translate: {
    /** Set CAT's Japanese-script logits to -inf: right when the target is English, wrong when it is Japanese. */
    readonly banSourceScript: boolean;
    prompt(src: JaText): PromptChoice;
    clean(raw: string): CleanedCat;
    /** True when the first pass should be redone without context turns. */
    retryWithoutContext(first: { readonly en: EnText; readonly raw: string }, context: readonly ContextTurn[], src: JaText): boolean;
    /** Null when numbers are not checked. */
    readonly numbers: NumberCheck | null;
    /** The pieces a line is translated in, one model call each, joined in order. */
    segments(src: JaText): readonly JaText[];
  };
  readonly source: {
    normalizePunctuation(text: JaText): JaText;
    applyGlossary(text: JaText, glossary: Glossary): JaText;
    /** True when the line is shown as is, with no translation. */
    passthrough(text: JaText): boolean;
    /** Whether a finished line is worth showing the translator as a prior turn. */
    contextEligible(src: JaText): boolean;
  };
  /** Partial-translation previews while the speaker is still talking. */
  readonly preview: boolean;
  /** Re-translating a sentence the VAD cut in two (the heuristics read Japanese endings). */
  readonly splitRepair: boolean;
}

const CONTEXT_MIN_CHARS = 6;
const SEGMENT_CHARS = 120;

/** Splits English after `.`, `?` or `!` and packs whole sentences into groups of at most `max` characters. */
export function sentenceGroups(src: JaText, max: number): JaText[] {
  const sentences = src.split(/(?<=[.?!])\s+/u).filter((s) => s !== "");
  const groups: string[] = [];
  for (const sentence of sentences) {
    const last = groups.length - 1;
    if (last >= 0 && groups[last]!.length + 1 + sentence.length <= max) groups[last] += ` ${sentence}`;
    else groups.push(sentence);
  }
  return groups.length === 0 ? [src] : groups.map(asJaText);
}
const longEnough = (src: JaText): boolean => cpLength(jaContent(src)) >= CONTEXT_MIN_CHARS;

const jaEn: PairStrategy = {
  translate: {
    banSourceScript: true,
    prompt: promptAndTokens,
    clean: cleanCat,
    segments: (src) => [src],
    retryWithoutContext: (first, context, src) =>
      first.en === "" || echoesContext(first.en, context, src) || tooShort(first.en, src) || isLabelled(first.raw),
    numbers: { unsupported: unsupportedNumbers, regroup: groupDigits },
  },
  source: {
    normalizePunctuation,
    applyGlossary,
    passthrough: isMostlyEnglish,
    contextEligible: (src) => longEnough(src) && !isMostlyEnglish(src),
  },
  preview: true,
  splitRepair: true,
};

const enJa: PairStrategy = {
  translate: {
    banSourceScript: false,
    prompt: enJaPromptAndTokens,
    clean: cleanCatEnJa,
    retryWithoutContext: (first, context, src) => first.en === "" || echoesContextEnJa(first.en, context, src),
    // Source numbers are digits or English words and the output may use kanji numerals, so no check is right.
    numbers: null,
    // CAT loops or drops clauses on a long paragraph, so a long line goes in sentence groups.
    segments: (src) => sentenceGroups(src, SEGMENT_CHARS),
  },
  source: {
    normalizePunctuation: normalizeEnglishPunctuation,
    applyGlossary: applyEnglishGlossary,
    passthrough: () => false,
    // With prior turns CAT 1.4B often answers en-ja in English or re-translates the previous line (seen in the
    // browser on FLEURS); without them every line came back as Japanese, so English source runs context-free.
    contextEligible: () => false,
  },
  preview: false,
  splitRepair: false,
};

const STRATEGIES: Readonly<Record<PairId, PairStrategy>> = { "ja-en": jaEn, "en-ja": enJa };

export function strategyFor(pair: PairId): PairStrategy {
  return STRATEGIES[pair];
}

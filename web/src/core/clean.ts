import { translationCacheKey } from "./cache";
import {
  PY_WHITESPACE,
  cpIndexOf,
  cpLength,
  cpSlice,
  hasJapanese,
  jaContent,
  pySplitLines,
  pyStrip,
  pyWordCount,
  replaceJapanese,
  rstripChars,
  stripChars,
} from "./text";
import type { ContextTurn, EnText, JaText } from "./types";
import { asEnText } from "./types";

/** Instruction text CAT sometimes echoes; everything from the first hit on is cut. */
export const PROMPT_LEAK_MARKERS: readonly string[] = [
  "Translate the following",
  "Please translate",
  "The meaning, tone",
  "Preserve the meaning",
  "avoid stiff literal",
  "avoid overly rigid",
  "Avoid using overly rigid",
  "Avoid using overly formal",
  "Avoid overly formal",
  "Avoid overly literal",
  "speaker intent",
  "can be translated",
  "has been translated",
  "Please keep the meaning",
  "Please preserve",
  "natural conversational English",
  "Your message",
  "message has been",
  "Translate to English",
  "following Japanese",
  "in Japanese",
  "In English,",
  "Let's keep playing",
  "speak English naturally",
  "I'll help you speak",
  "I'll help you",
  "I can help you",
  "that was incorrect",
  "This Japanese phrase",
  "correct translation:",
  "ccenture",
  "Here is the instruction",
  "English:",
  "this phrase in English",
  "Japanese:",
  "Please use the",
];

const LOWERCASE_MARKERS = PROMPT_LEAK_MARKERS.map((marker) => marker.toLowerCase());
const PROMPT_SUFFIX = new RegExp(`[.${PY_WHITESPACE}]?English:[${PY_WHITESPACE}]*$`, "u");
const JA_PUNCTUATION_RUN = /[。、！？・…]+/gu;
const WHITESPACE_RUNS = new RegExp(`[${PY_WHITESPACE}]+`, "gu");
// A reply that labels itself ("Translation: ...") came from a context turn that was a fragment.
const LABELLED = new RegExp(`^[${PY_WHITESPACE}]*(?:translation|english translation)[${PY_WHITESPACE}]*:`, "iu");

export interface CleanedCat {
  readonly text: EnText;
  readonly promptLeak: boolean;
  readonly japaneseStripped: boolean;
}

/** Clean raw CAT output: cut leaked prompt text, fall back to the first sentence, drop Japanese script. */
export function cleanCat(rawOutput: string): CleanedCat {
  let raw = rawOutput;
  let rawLower = raw.toLowerCase();
  let promptLeak = false;
  for (const marker of LOWERCASE_MARKERS) {
    const index = cpIndexOf(rawLower, marker);
    if (index === -1) continue;
    promptLeak = true;
    raw = pyStrip(cpSlice(raw, 0, index));
    rawLower = pyStrip(cpSlice(rawLower, 0, index));
  }

  let result = pySplitLines(raw)
    .map(pyStrip)
    .filter((line) => line !== "")
    .join(" ");
  if (pyWordCount(result) < 2) {
    for (const separator of [".", "!", "?"]) {
      const index = cpIndexOf(raw, separator);
      if (index <= 0 || index >= 120) continue;
      const candidate = pyStrip(cpSlice(raw, 0, index + 1));
      const lowered = candidate.toLowerCase();
      if (!LOWERCASE_MARKERS.some((marker) => lowered.includes(marker))) {
        result = candidate;
        break;
      }
    }
  }
  result = rstripChars(pyStrip(result.replace(PROMPT_SUFFIX, "")), ".");

  const japaneseStripped = hasJapanese(result);
  if (japaneseStripped) {
    result = replaceJapanese(result, " ")
      .replace(JA_PUNCTUATION_RUN, " ")
      .replace(WHITESPACE_RUNS, " ");
    result = stripChars(pyStrip(result), ".,;: ");
  }
  return { text: asEnText(result), promptLeak, japaneseStripped };
}

/** True when the reply labels itself, so the line should be retranslated without context. */
export function isLabelled(raw: string): boolean {
  return LABELLED.test(raw);
}

const ECHO_MIN_WORDS = 4;

function wordNgrams(text: string, n: number): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const grams = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) grams.add(words.slice(i, i + n).join(" "));
  return grams;
}

function sentences(text: string, terminators: string): string[] {
  return pyStrip(text)
    .split(new RegExp(`(?<=[${terminators}])`, "u"))
    .map(pyStrip)
    .filter((part) => part !== "");
}

function normalized(sentence: string): string {
  return (sentence.toLowerCase().match(/[a-z0-9']+/g) ?? []).join(" ");
}

function jaSentenceKeys(ja: string): Set<string> {
  const keys = new Set<string>(
    sentences(ja, "。！？!?").map((s) => translationCacheKey(rstripChars(s, "。！？!?"))),
  );
  keys.delete("");
  return keys;
}

/**
 * True when CAT copied from a prior line instead of translating: a shared run of
 * words, or a prior sentence repeated whole unless the prior line shares a
 * Japanese sentence with this one (a second はい).
 */
export function echoesContext(en: EnText, context: readonly ContextTurn[], ja: JaText): boolean {
  const produced = wordNgrams(en, ECHO_MIN_WORDS);
  if (context.some((turn) => [...wordNgrams(turn.en, ECHO_MIN_WORDS)].some((gram) => produced.has(gram)))) {
    return true;
  }
  const said = jaSentenceKeys(ja);
  const prior = new Set(
    context
      .filter((turn) => ![...jaSentenceKeys(turn.ja)].some((key) => said.has(key)))
      .flatMap((turn) => sentences(turn.en, ".!?").map(normalized)),
  );
  prior.delete("");
  return sentences(en, ".!?").some((sentence) => prior.has(normalized(sentence)));
}

/** True when the English is far shorter than any translation of the Japanese: under one word per 6 content characters. */
export function tooShort(en: EnText, ja: JaText): boolean {
  const words = (en.match(/[A-Za-z0-9']+/g) ?? []).length;
  return words * 6 < cpLength(jaContent(ja));
}

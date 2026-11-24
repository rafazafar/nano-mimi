import type { JaText } from "./types";
import { asJaText } from "./types";

// Python's str.isspace() set, which str.strip(), str.split() and re's \s follow.
// JS \s and trim() differ: they include U+FEFF and leave out U+001C-U+001F and U+0085.
export const PY_WHITESPACE =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const LEADING_WHITESPACE = new RegExp(`^[${PY_WHITESPACE}]+`, "u");
const TRAILING_WHITESPACE = new RegExp(`[${PY_WHITESPACE}]+$`, "u");
const WHITESPACE_RUN = new RegExp(`[${PY_WHITESPACE}]+`, "u");
const LINE_BREAK = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029]", "u");

export function pyStrip(text: string): string {
  return text.replace(LEADING_WHITESPACE, "").replace(TRAILING_WHITESPACE, "");
}

/** `str.rstrip(chars)` for a set of BMP characters. */
export function rstripChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

/** `str.strip(chars)` for a set of BMP characters. */
export function stripChars(text: string, chars: string): string {
  let start = 0;
  while (start < text.length && chars.includes(text.charAt(start))) start++;
  return rstripChars(text.slice(start), chars);
}

export function pySplitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

/** `len(text.split())`. */
export function pyWordCount(text: string): number {
  return pyStrip(text)
    .split(WHITESPACE_RUN)
    .filter((word) => word !== "").length;
}

// Python indexes by code point, JS by UTF-16 unit; an astral character is one in Python.
export function cpLength(text: string): number {
  return [...text].length;
}

export function cpSlice(text: string, start: number, end?: number): string {
  return [...text].slice(start, end).join("");
}

/** `text.find(needle)` as a code point index, or -1. */
export function cpIndexOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  return index === -1 ? -1 : cpLength(text.slice(0, index));
}

const JAPANESE_CHARS = "\\u3040-\\u30ff\\u4e00-\\u9fff\\u3400-\\u4dbf\\uff65-\\uff9f";
const JAPANESE_CHAR = new RegExp(`[${JAPANESE_CHARS}]`, "u");
const JAPANESE_CHAR_GLOBAL = new RegExp(`[${JAPANESE_CHARS}]`, "gu");

export function hasJapanese(text: string): boolean {
  return JAPANESE_CHAR.test(text);
}

export function replaceJapanese(text: string, replacement: string): string {
  return text.replace(JAPANESE_CHAR_GLOBAL, replacement);
}

const JA_CONTENT_NOISE = new RegExp(`[${PY_WHITESPACE}。、！？!?,.「」…ー]+`, "gu");

/** The characters of a JA line that carry content: no whitespace or punctuation. */
export function jaContent(ja: string): string {
  return ja.replace(JA_CONTENT_NOISE, "");
}

export function normalizePunctuation(text: JaText): JaText {
  const stripped = pyStrip(text);
  const needsStop = stripped !== "" && !"。！？.!?".includes(stripped.slice(-1));
  return asJaText(needsStop ? `${stripped}。` : stripped);
}

const NON_CONTENT = new RegExp(
  `^[${PY_WHITESPACE}。、．，.！？!?・…‥\\-—–~～「」『』（）()\\[\\]【】〈〉《》"'‘’“”\`´]+$`,
  "u",
);

/** True when ASR output is empty or punctuation-only. */
export function isNonContentAsr(text: JaText): boolean {
  const stripped = pyStrip(text);
  return stripped === "" || NON_CONTENT.test(stripped);
}

const SEPARATED_LOOP = new RegExp(
  `([^。、${PY_WHITESPACE}]{1,12}[、。，.]?[${PY_WHITESPACE}]*)\\1{3,}`,
  "gu",
);
const PLAIN_LOOP = /([^\n]{1,15}?)\1{4,}/gu;
const TOKEN_SEPARATOR = new RegExp(`[${PY_WHITESPACE}、。！？]+`, "u");

/** Collapse repeated-phrase loops from ASR decode hallucinations. */
export function deduplicatePhrases(text: JaText): JaText {
  const collapsed = text.replace(SEPARATED_LOOP, "$1").replace(PLAIN_LOOP, "$1");
  const tokens = pyStrip(collapsed)
    .split(TOKEN_SEPARATOR)
    .filter((token) => token !== "");
  if (tokens.length < 8) return asJaText(collapsed);

  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  let dominant = "";
  let dominantCount = 0;
  for (const [token, count] of counts) {
    if (count > dominantCount) [dominant, dominantCount] = [token, count];
  }
  if (dominantCount < 4 || dominantCount <= tokens.length * 0.5) return asJaText(collapsed);

  let seen = 0;
  const kept = tokens.filter((token) => token !== dominant || ++seen <= 2);
  return asJaText(
    kept.length > tokens.length * 0.8
      ? kept.slice(0, Math.max(3, Math.floor(tokens.length / 4))).join(" ")
      : kept.join(" "),
  );
}

/** True when ASR text is a code-switch into English: almost no Japanese among its letters. */
export function isMostlyEnglish(text: JaText): boolean {
  const stripped = pyStrip(text);
  if (stripped === "") return false;
  const japanese = (stripped.match(JAPANESE_CHAR_GLOBAL) ?? []).length;
  if (japanese >= 3) return false;
  const letters = [...stripped].filter((char) => /\p{L}/u.test(char)).length;
  return letters > 0 && japanese / letters < 0.2;
}

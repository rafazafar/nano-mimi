import { cpLength, hasJapanese } from "./text";
import type { JaText } from "./types";
import { asJaText } from "./types";

/** Source -> target in insertion order, which breaks ties between equally long sources. */
export type Glossary = ReadonlyMap<string, string>;

/** `str.replace` for a literal pattern, including Python's empty-pattern behavior. */
function replaceLiteral(text: string, from: string, to: string): string {
  if (from === "") return [...text].map((char) => to + char).join("") + to;
  return text.split(from).join(to);
}

/** Substitute glossary entries, longest source first so "よろしくお願いします" wins over "お願いします". */
export function applyGlossary(text: JaText, glossary: Glossary): JaText {
  const sources = [...glossary.keys()].sort((a, b) => cpLength(b) - cpLength(a));
  let result: string = text;
  for (const source of sources) result = replaceLiteral(result, source, glossary.get(source) ?? "");
  return asJaText(result);
}

/** A target containing Japanese is an ASR spelling fix, not a term to translate. */
export function isAsrFix(target: string): boolean {
  return hasJapanese(target);
}

/** Sources of term entries (non-Japanese target), in glossary order. */
export function termSources(glossary: Glossary): string[] {
  return [...glossary]
    .filter(([source, target]) => source !== "" && target !== "" && !isAsrFix(target))
    .map(([source]) => source);
}

const WORD_CHAR = String.raw`\p{L}\p{N}_`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * English source: substitute each term (English source, Japanese target) wherever it appears as whole words,
 * ignoring case, longest first. Entries with a Japanese source are ASR fixes for Japanese speech and never match.
 */
export function applyEnglishGlossary(text: JaText, glossary: Glossary): JaText {
  const sources = [...glossary.keys()]
    .filter((source) => source.trim() !== "" && !hasJapanese(source))
    .sort((a, b) => cpLength(b) - cpLength(a));
  let result: string = text;
  for (const source of sources) {
    const term = new RegExp(`(?<![${WORD_CHAR}])${escapeRegExp(source.trim())}(?![${WORD_CHAR}])`, "giu");
    result = result.replace(term, () => glossary.get(source) ?? "");
  }
  return asJaText(result);
}

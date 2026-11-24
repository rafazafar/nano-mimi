/**
 * The translation direction. `ja-en` (Japanese speech, English captions) is the original path;
 * `en-ja` (English speech, Japanese captions) is for Japanese listeners.
 *
 * Pipeline types keep their `ja` / `en` names for both directions, as the desktop wire format does:
 * `JaText` holds the recognized *source* text and `EnText` the *translation*.
 */
export type PairId = "ja-en" | "en-ja";

export const PAIR_IDS: readonly PairId[] = ["ja-en", "en-ja"];

export function parsePair(raw: string | null): PairId | null {
  return raw === "ja-en" || raw === "en-ja" ? raw : null;
}

/** A browser that prefers Japanese gets English speech with Japanese captions; everyone else the reverse. */
export function defaultPair(languages: readonly string[]): PairId {
  return isJapanese(languages) ? "en-ja" : "ja-en";
}

/** True when the browser's first preferred language is Japanese. */
export function isJapanese(languages: readonly string[]): boolean {
  return /^ja(-|$)/i.test(languages[0] ?? "");
}

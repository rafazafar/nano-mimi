import { applyGlossary } from "./glossary";
import type { Glossary } from "./glossary";
import { PY_WHITESPACE, normalizePunctuation } from "./text";
import type { EnText, JaCacheKey, JaText } from "./types";
import { asEnText } from "./types";

const WHITESPACE_RUNS = new RegExp(`[${PY_WHITESPACE}]+`, "gu");

/** Whitespace-insensitive JA key, so a preview's spaced join and the final share an entry. */
export function translationCacheKey(text: string): JaCacheKey {
  return text.replace(WHITESPACE_RUNS, "") as JaCacheKey;
}

/** The key a line is cached under: punctuation-normalized, glossary-substituted, whitespace removed. */
export function jaCacheKey(ja: JaText, glossary: Glossary): JaCacheKey {
  return translationCacheKey(applyGlossary(normalizePunctuation(ja), glossary));
}

export const TRANSLATION_CACHE_MAX = 256;

/** Built-in opener, filler and stock-phrase translations; always present after `reset`. */
export const STOCK_PHRASES: ReadonlyMap<string, EnText> = new Map(
  Object.entries({
    "お兄ちゃん。": "Big brother.",
    "お兄ちゃん、がんばって！": "Come on, big brother!",
    "お兄ちゃん、がんばって!": "Come on, big brother!",
    "お兄ちゃん、えらーい!": "Wow, big brother!",
    "お父さん。": "Dad.",
    "お母さん。": "Mom.",
    "おはよう。": "Good morning.",
    "おはよう!": "Good morning!",
    "はーい。": "Yes!",
    "はい。": "Yes.",
    "ありがとう。": "Thank you.",
    "ありがとうございました。": "Thank you very much.",
    "おやすみ。": "Good night.",
    "おやすみなさい。": "Good night.",
    "いいよ。": "Okay.",
    "わかった。": "Understood.",
    "いただきます。": "Let me begin.",
    "では始めさせていただきます。": "Let me begin.",
    "ごちそうさま。": "Thanks for the meal.",
    "ごちそうさまでした。": "Thanks for the meal.",
    "ん。": "Mm.",
    "競争?": "Competition?",
    "競争。": "Competition.",
    "頑張りなさい。": "Do your best!",
    "ごめんなさい。": "I'm sorry.",
    "ごめんごめん。": "Sorry, sorry.",
    "豚肉。": "Pork.",
    "カレー大好き!": "I love curry!",
    "ほのかは。": "Honoka,",
    "先に入る。": "I'll go first.",
    "お父さん、俺の方が早い!": "Dad, I'm faster!",
  }).map(([ja, en]) => [ja, asEnText(en)]),
);

/**
 * Least-recently-used translations keyed by whitespace-free JA. A hit refreshes
 * recency; stock phrases count toward the cap and age out like any entry.
 */
export class TranslationCache {
  #entries = new Map<string, EnText>(STOCK_PHRASES);

  /** Drop runtime entries and restore the stock phrases. */
  reset(): void {
    this.#entries = new Map(STOCK_PHRASES);
  }

  /** Cached English for a normalized, glossary-substituted line: by key, else by the exact text. */
  lookup(ja: JaText): EnText | undefined {
    const key = translationCacheKey(ja);
    const slot = this.#entries.has(key) ? key : ja;
    const hit = this.#entries.get(slot);
    if (hit !== undefined) this.#touch(slot, hit);
    return hit;
  }

  /** True when a preview of this line is already cached under its key. */
  has(ja: JaText): boolean {
    return this.#entries.has(translationCacheKey(ja));
  }

  /** Cache a finished preview under the line's key. */
  storePreview(ja: JaText, en: EnText): void {
    const key = translationCacheKey(ja);
    this.#entries.set(key, en);
    this.#touch(key, en);
    this.#evict();
  }

  /** Cache a final under the line's key and, when it differs, under the exact text. */
  storeFinal(ja: JaText, en: EnText): void {
    const key = translationCacheKey(ja);
    this.#entries.set(key, en);
    const exact: string = ja;
    if (exact !== key) this.#entries.set(exact, en);
    this.#evict();
  }

  /** Keys oldest first. */
  entries(): [string, EnText][] {
    return [...this.#entries];
  }

  #touch(slot: string, en: EnText): void {
    this.#entries.delete(slot);
    this.#entries.set(slot, en);
  }

  #evict(): void {
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= TRANSLATION_CACHE_MAX) return;
      this.#entries.delete(oldest);
    }
  }
}

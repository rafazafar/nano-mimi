declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Japanese (or code-switched) source text: ASR output, glossary-substituted or not. */
export type JaText = Brand<string, "JaText">;
/** English text produced by the translator or passed through from the source. */
export type EnText = Brand<string, "EnText">;
/** Whitespace-free form of a JA line, under which translations are cached. */
export type JaCacheKey = Brand<string, "JaCacheKey">;

/** One finished line shown to the translator as a prior chat turn. */
export interface ContextTurn {
  readonly ja: JaText;
  readonly en: EnText;
}

export const asJaText = (text: string): JaText => text as JaText;
export const asEnText = (text: string): EnText => text as EnText;

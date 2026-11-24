import type { PairId } from "../core/pair";

export type Lang = "ja" | "en";

/** The language people speak in this direction. Pipeline types call its text `ja` in both directions. */
export const sourceLang = (pair: PairId): Lang => (pair === "ja-en" ? "ja" : "en");

/** The language of the captions this direction produces. Pipeline types call its text `en` in both directions. */
export const targetLang = (pair: PairId): Lang => (pair === "ja-en" ? "en" : "ja");

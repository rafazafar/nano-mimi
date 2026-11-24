// Kana, kanji, CJK punctuation and fullwidth forms, plus the byte-fallback tokens that
// start them in UTF-8 (U+3000..U+9FFF lead with E3..E9, fullwidth with EF).
const CJK_PIECE = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;
const CJK_BYTE = /^<0x(?:E[3-9]|EF)>$/u;

/** Ids of vocabulary tokens that put Japanese script into the output; banned while decoding. */
export function japaneseTokenIds(vocab: ReadonlyMap<string, number>): number[] {
  return [...vocab]
    .filter(([piece]) => CJK_PIECE.test(piece) || CJK_BYTE.test(piece))
    .map(([, id]) => id)
    .sort((a, b) => a - b);
}

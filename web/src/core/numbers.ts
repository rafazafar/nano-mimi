import { PY_WHITESPACE } from "./text";
import type { EnText, JaText } from "./types";
import { asJaText } from "./types";

const KANJI_DIGITS: ReadonlyMap<string, number> = new Map(
  [..."〇一二三四五六七八九"].map((char, value) => [char, value]),
);
const KANJI_UNITS: ReadonlyMap<string, number> = new Map([
  ["十", 10],
  ["百", 100],
  ["千", 1000],
]);
const KANJI_MYRIADS: ReadonlyMap<string, number> = new Map([
  ["万", 1e4],
  ["億", 1e8],
  ["兆", 1e12],
]);
// A counter right after a number that scales it in English ("2割" is "20 percent").
const JA_COUNTER_SCALES: ReadonlyMap<string, number> = new Map([["割", 10]]);
const EN_SCALES: ReadonlyMap<string, number> = new Map([
  ["hundred", 100],
  ["thousand", 1000],
  ["million", 1e6],
  ["billion", 1e9],
  ["trillion", 1e12],
]);

// Python's \d is any decimal digit and \w any letter, number or underscore; JS's are ASCII.
const ARABIC = String.raw`\p{Nd}+(?:,\p{Nd}{3})*(?:\.\p{Nd}+)?`;
const JA_NUMBER = new RegExp(`(?:${ARABIC}|[〇一二三四五六七八九十百千万億兆])+`, "gu");
const ARABIC_RUN = new RegExp(ARABIC, "gu");
const TOKEN_PART = new RegExp(`${ARABIC}|.`, "gu");
// \b is ASCII-only in JS; after a scale word it means "no letter, number or underscore follows".
const EN_NUMBER = new RegExp(
  `(?<![\\p{L}\\p{N}_.])(${ARABIC})(?:[${PY_WHITESPACE}]+(${[...EN_SCALES.keys()].join("|")})(?![\\p{L}\\p{N}_]))?`,
  "giu",
);
// A bare integer of 4+ digits that is not a year: "7000" but not "1789年".
const UNGROUPED = new RegExp(
  `(?<![\\p{Nd},.])(\\p{Nd}{4,})(?![\\p{Nd},.]|[${PY_WHITESPACE}]*年)`,
  "gu",
);

/** Decimal digits of any script as ASCII; each Unicode digit block is runs of 0-9. */
function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    let zero = code;
    while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
    return String((code - zero) % 10);
  });
}

function value(arabic: string): number {
  return Number(asciiDigits(arabic).replaceAll(",", ""));
}

/** Value of a numeral run mixing Arabic digits and kanji ("7千", "三百五十"). */
function parseJa(token: string): number {
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const [part] of token.matchAll(TOKEN_PART)) {
    const kanjiDigit = KANJI_DIGITS.get(part);
    const unit = KANJI_UNITS.get(part);
    const myriad = KANJI_MYRIADS.get(part);
    if (/^\p{Nd}/u.test(part)) {
      digit = value(part);
    } else if (kanjiDigit !== undefined) {
      digit = digit * 10 + kanjiDigit; // "二〇二四" reads digit by digit
    } else if (unit !== undefined) {
      section += (digit || 1) * unit;
      digit = 0;
    } else if (myriad !== undefined) {
      total += ((section + digit) || 1) * myriad;
      section = 0;
      digit = 0;
    }
  }
  return total + section + digit;
}

/** Every value a Japanese line accounts for: each numeral run, its Arabic parts, and the run scaled by a counter. */
function jaNumbers(ja: string): Set<number> {
  const text = ja.normalize("NFKC");
  const values = new Set<number>();
  for (const match of text.matchAll(JA_NUMBER)) {
    const run = new Set([parseJa(match[0]), ...match[0].match(ARABIC_RUN)?.map(value) ?? []]);
    const end = (match.index ?? 0) + match[0].length;
    const scale = JA_COUNTER_SCALES.get(text.slice(end, end + 1)) ?? 1;
    for (const v of run) {
      values.add(v);
      values.add(v * scale);
    }
  }
  return values;
}

/** English numbers that match no number in the Japanese line, in order. */
export function unsupportedNumbers(ja: JaText, en: EnText): string[] {
  const allowed = jaNumbers(ja);
  const missing: string[] = [];
  for (const match of en.matchAll(EN_NUMBER)) {
    const base = value(match[1] ?? "");
    const scale = EN_SCALES.get((match[2] ?? "").toLowerCase());
    const scaled = scale === undefined ? base : base * scale;
    if (!allowed.has(base) && !allowed.has(scaled)) missing.push(match[0]);
  }
  return missing;
}

/** Write bare 4+ digit integers with thousands separators ("7000" -> "7,000"), leaving years alone. */
export function groupDigits(ja: JaText): JaText {
  return asJaText(
    ja.replace(UNGROUPED, (digits) =>
      BigInt(asciiDigits(digits))
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, ","),
    ),
  );
}

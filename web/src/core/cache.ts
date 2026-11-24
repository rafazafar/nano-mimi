// Python's str.isspace() set, which str.strip() and re's \s follow.
const PY_WHITESPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WHITESPACE_RUNS = new RegExp(`[${PY_WHITESPACE}]+`, "g");

/** Whitespace-insensitive JA key, so a preview's spaced join and the final share an entry. */
export function translationCacheKey(text: string): string {
  return text.replace(WHITESPACE_RUNS, "");
}

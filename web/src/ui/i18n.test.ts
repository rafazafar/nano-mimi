import { describe, expect, it } from "vitest";
import { catalogs, messagesFor, pickLocale } from "./i18n";

/** Dotted paths of every leaf, with functions marked by their arity so a changed signature shows up too. */
function shape(value: unknown, path = ""): string[] {
  if (typeof value === "function") return [`${path}(${value.length})`];
  // Rich text runs differ in length between languages; only the number of items must match.
  if (Array.isArray(value)) return [`${path}[${value.length}]`];
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([k, v]) => shape(v, path === "" ? k : `${path}.${k}`));
  return [path];
}

describe("catalogs", () => {
  it("define the same keys in both languages", () => {
    expect(shape(catalogs.ja)).toEqual(shape(catalogs.en));
  });

  it("have no empty strings", () => {
    const empty = (value: unknown, path: string): string[] =>
      typeof value === "string"
        ? value === "" ? [path] : []
        : typeof value === "object" && value !== null
          ? Object.entries(value).flatMap(([k, v]) => empty(v, `${path}.${k}`))
          : [];
    expect([...empty(catalogs.en, "en"), ...empty(catalogs.ja, "ja")]).toEqual([]);
  });

  it("know their own locale", () => {
    expect(messagesFor("en").locale).toBe("en");
    expect(messagesFor("ja").locale).toBe("ja");
  });
});

describe("pickLocale", () => {
  it("follows the browser's first language", () => {
    expect(pickLocale(["ja-JP", "en-US"], "")).toBe("ja");
    expect(pickLocale(["ja"], "")).toBe("ja");
    expect(pickLocale(["en-US", "ja"], "")).toBe("en");
    expect(pickLocale([], "")).toBe("en");
  });

  it("lets ?lang pin either language and ignores other values", () => {
    expect(pickLocale(["ja-JP"], "?lang=en")).toBe("en");
    expect(pickLocale(["en-US"], "?lang=ja")).toBe("ja");
    expect(pickLocale(["ja-JP"], "?lang=fr")).toBe("ja");
  });
});

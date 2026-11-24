import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./storage";
import { THEME_KEY, effectiveTheme, loadTheme, parseThemeChoice, saveTheme, toggleTheme } from "./theme";

describe("theme", () => {
  it("parses only the two explicit choices", () => {
    expect(parseThemeChoice("light")).toBe("light");
    expect(parseThemeChoice("dark")).toBe("dark");
    expect(parseThemeChoice("sepia")).toBe("system");
    expect(parseThemeChoice("")).toBe("system");
    expect(parseThemeChoice(null)).toBe("system");
  });

  it("resolves system against the OS preference", () => {
    expect(effectiveTheme("system", true)).toBe("dark");
    expect(effectiveTheme("system", false)).toBe("light");
    expect(effectiveTheme("light", true)).toBe("light");
  });

  it("flips what the user sees and returns to system when that matches the OS", () => {
    expect(toggleTheme("system", true)).toBe("light");
    expect(toggleTheme("light", true)).toBe("system");
    expect(toggleTheme("system", false)).toBe("dark");
    expect(toggleTheme("dark", false)).toBe("system");
    expect(toggleTheme("dark", true)).toBe("light");
  });

  it("stores an explicit choice and clears the key for system", () => {
    const storage = new MemoryStorage();
    saveTheme(storage, "dark");
    expect(storage.getItem(THEME_KEY)).toBe("dark");
    expect(loadTheme(storage)).toBe("dark");
    saveTheme(storage, "system");
    expect(storage.getItem(THEME_KEY)).toBeNull();
    expect(loadTheme(storage)).toBe("system");
  });
});

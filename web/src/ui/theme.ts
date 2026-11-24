import { clearItem, readItem, writeItem, type KeyValueStorage } from "./storage";

/** `system` follows prefers-color-scheme; the other two are the user's explicit choice. */
export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_KEY = "mimivox.theme.v1";

export function parseThemeChoice(raw: string | null): ThemeChoice {
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function effectiveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}

/**
 * The toggle flips what the user sees. Flipping to the theme the system already asks for goes back to
 * following the system, so the page keeps tracking it if the OS switches at sunset.
 */
export function toggleTheme(choice: ThemeChoice, systemDark: boolean): ThemeChoice {
  const next: Theme = effectiveTheme(choice, systemDark) === "dark" ? "light" : "dark";
  return next === (systemDark ? "dark" : "light") ? "system" : next;
}

export function loadTheme(storage: KeyValueStorage): ThemeChoice {
  return parseThemeChoice(readItem(storage, THEME_KEY));
}

export function saveTheme(storage: KeyValueStorage, choice: ThemeChoice): void {
  if (choice === "system") clearItem(storage, THEME_KEY);
  else writeItem(storage, THEME_KEY, choice);
}

export function applyTheme(root: HTMLElement, choice: ThemeChoice): void {
  if (choice === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = choice;
}

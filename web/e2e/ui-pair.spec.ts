import { expect, test, type Page } from "@playwright/test";
import { emit, ev, expectAppState, openHarness, reachReady, reachRunning } from "./ui-harness/driver";

const role = (page: Page, name: string) => page.locator(`[data-role="${name}"]`);
const PAIR_KEY = "mimivox.pair.v1";
const pill = (page: Page) => role(page, "pair");
const menu = (page: Page) => role(page, "pair-menu");
const item = (page: Page, pair: string) => page.locator(`.pair-item[data-pair="${pair}"]`);

test.describe("a Japanese browser", () => {
  test("starts in English to Japanese with the whole UI in Japanese", async ({ page }) => {
    await openHarness(page, { lang: "ja-JP" });
    await expectAppState(page, "needs-setup");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page).toHaveTitle("MimiVox ライブ字幕");
    await expect(pill(page)).toHaveText("EN → JA");
    await expect(page.locator('[data-role="status-label"]')).toHaveText("セットアップが必要です");
    await expect(page.locator(".setup-head h1")).toHaveText("ライブ字幕のセットアップ");
    await expect(role(page, "speech-model")).toContainText("Parakeet");
    await expect(role(page, "download")).toHaveText(/ をダウンロード$/);
    await expect(page.locator(".option .tag-ok")).toHaveText("この端末におすすめ");
    await expect(role(page, "glossary")).toContainText("用語集");
    await expect(page.locator('[data-role="diagnostics"] summary')).toHaveText("診断情報");
    await expect(page.locator("html")).not.toContainText("Set up live captions");
  });

  test("shows the live view and captions in Japanese", async ({ page }) => {
    await reachReady(page, { lang: "ja-JP" });
    await expect(role(page, "start")).toHaveText("字幕を開始");
    await expect(page.locator(".empty-body")).toContainText("英語で話してください");
    await expect(role(page, "source")).toContainText("マイク");

    await role(page, "start").click();
    await expectAppState(page, "running");
    await emit(page, ev.translating(1, 4, "Good morning, everyone."), ev.final(1, 4, "Good morning, everyone.", "皆さん、おはようございます。"));
    const row = page.locator('.row[data-row-id="1"]');
    await expect(row.locator(".row-en")).toHaveAttribute("lang", "ja");
    await expect(row.locator(".en-text")).toHaveText("皆さん、おはようございます。");
    await expect(row.locator(".row-ja")).toHaveAttribute("lang", "en");
    await expect(row.locator(".row-ja")).toHaveText("Good morning, everyone.");
    await expect(row.locator(".row-en")).toHaveCSS("line-break", "strict");
    await expect(role(page, "start")).toHaveText("停止");
    await emit(page, ev.backlog(4, "behind"));
    await expect(role(page, "health-label")).toHaveText("4 秒遅れ");
  });

  test("keeps a stored Japanese-to-English choice, with the UI in English like its captions", async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, "ja-en"), PAIR_KEY);
    await openHarness(page, { lang: "ja-JP" });
    await expectAppState(page, "needs-setup");
    await expect(pill(page)).toHaveText("JA → EN");
    await expect(role(page, "speech-model")).toContainText("Haas-ja");
    await expect(page.locator(".setup-head h1")).toHaveText("Set up live captions");
  });
});

test.describe("an English browser", () => {
  test("starts in Japanese to English with the English UI", async ({ page }) => {
    await openHarness(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(pill(page)).toHaveText("JA → EN");
    await expect(role(page, "speech-model")).toContainText("Haas-ja");
    await expect(page.locator(".setup-head h1")).toHaveText("Set up live captions");
  });
});

test.describe("the direction menu", () => {
  test("lists both directions in the UI language with the current one checked", async ({ page }) => {
    await openHarness(page, { lang: "ja-JP" });
    await expect(menu(page)).toBeHidden();
    await expect(pill(page)).toHaveAttribute("aria-expanded", "false");
    await pill(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(pill(page)).toHaveAttribute("aria-expanded", "true");
    await expect(item(page, "en-ja")).toContainText("英語 → 日本語");
    await expect(item(page, "en-ja")).toContainText("英語の会議を日本語字幕で");
    await expect(item(page, "ja-en")).toContainText("日本語 → 英語");
    await expect(item(page, "ja-en")).toContainText("日本語の会議を英語字幕で");
    await expect(item(page, "en-ja")).toHaveAttribute("aria-checked", "true");
    await expect(item(page, "ja-en")).toHaveAttribute("aria-checked", "false");
    await expect(item(page, "en-ja")).toBeFocused();
  });

  test("switching updates the pill, the stored choice and returns to setup", async ({ page }) => {
    await openHarness(page, { lang: "ja-JP" });
    await expectAppState(page, "needs-setup");
    await pill(page).click();
    await item(page, "ja-en").click();
    await expect(pill(page)).toHaveText("JA → EN");
    await expect(pill(page)).toBeFocused();
    await expect(menu(page)).toBeHidden();
    await expectAppState(page, "needs-setup");
    await expect(role(page, "speech-model")).toContainText("Haas-ja");
    expect(await page.evaluate((key) => localStorage.getItem(key), PAIR_KEY)).toBe("ja-en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator(".setup-head h1")).toHaveText("Set up live captions");

    await page.reload();
    await expect(pill(page)).toHaveText("JA → EN");
  });

  test("with the models on disk, a switch reloads the engines for the other pair and clears the captions", async ({ page }) => {
    await reachRunning(page, { stored: "all" });
    await emit(page, ev.translating(1, 2, "おはよう"), ev.final(1, 2, "おはよう", "Good morning."));
    await expect(page.locator(".row:not(.draft)")).toHaveCount(1);
    await role(page, "start").click();
    await expectAppState(page, "ready");

    await pill(page).click();
    await item(page, "en-ja").click();
    await expectAppState(page, "loading-engines");
    await expect(pill(page)).toHaveText("EN → JA");
    await expect(pill(page)).toBeDisabled();
    await expect(pill(page)).toHaveAttribute("title", /ダウンロード|読み込み/);
    await page.evaluate(() => {
      const engines = window.__harness!.engines;
      for (const phase of ["vad", "asr", "mt"] as const) {
        engines.phase(phase, "start");
        engines.phase(phase, "done");
      }
      engines.finish();
    });
    await expectAppState(page, "ready");
    await expect(page.locator(".row:not(.draft)")).toHaveCount(0);
    await expect(pill(page)).toBeEnabled();
    await expect(page.locator(".empty-body")).toContainText("英語で話してください");
  });

  test("is disabled with a reason while captions run, and when downloading", async ({ page }) => {
    await reachRunning(page);
    await expect(pill(page)).toBeDisabled();
    await expect(pill(page)).toHaveAttribute("title", "Stop captions to change the direction.");
    await page.goto("/e2e/ui-harness/index.html");
    await page.waitForFunction(() => window.__harness !== undefined);
    await expectAppState(page, "needs-setup");
    await expect(pill(page)).toBeEnabled();
    await role(page, "download").click();
    await expectAppState(page, "downloading");
    await expect(pill(page)).toBeDisabled();
  });

  test("is enabled after an error", async ({ page }) => {
    await openHarness(page, { stored: "all" });
    await expectAppState(page, "loading-engines");
    await page.evaluate(() => window.__harness!.engines.fail("no luck"));
    await expectAppState(page, "error");
    await expect(pill(page)).toBeEnabled();
  });

  test("works from the keyboard and returns focus to the button", async ({ page }) => {
    await openHarness(page);
    await pill(page).focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu(page)).toBeVisible();
    await expect(item(page, "ja-en")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(item(page, "en-ja")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(item(page, "ja-en")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(item(page, "en-ja")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();
    await expect(pill(page)).toBeFocused();
    await expect(pill(page)).toHaveText("JA → EN");

    await page.keyboard.press("Enter");
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(pill(page)).toHaveText("EN → JA");
    await expect(pill(page)).toBeFocused();

    await page.keyboard.press("Space");
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    await expect(pill(page)).toHaveText("JA → EN");
  });

  test("closes on a click outside", async ({ page }) => {
    await openHarness(page);
    await pill(page).click();
    await expect(menu(page)).toBeVisible();
    await page.locator(".setup-head h1").click();
    await expect(menu(page)).toBeHidden();
    await expect(pill(page)).toHaveText("JA → EN");
  });

  test("picking the current direction only closes the menu", async ({ page }) => {
    await reachReady(page);
    await pill(page).click();
    await item(page, "ja-en").click();
    await expect(menu(page)).toBeHidden();
    await expectAppState(page, "ready");
  });
});

test.describe("per-pair glossary", () => {
  test("shows the pair's own entries and column headings", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("mimivox.glossary.v1", JSON.stringify({ version: 1, entries: [{ source: "ミミ", target: "Mimi" }] }));
      localStorage.setItem("mimivox.glossary.en-ja.v1", JSON.stringify({ version: 1, entries: [{ source: "standup", target: "朝会" }] }));
    });
    await openHarness(page, { lang: "ja-JP" });
    await expect(page.locator(".entry .entry-src")).toHaveValue("standup");
    await expect(page.locator(".entry .entry-dst")).toHaveValue("朝会");
    await expect(role(page, "glossary-heads")).toContainText("英語（認識結果）");
    await expect(role(page, "glossary-heads")).toContainText("日本語");

    await pill(page).click();
    await item(page, "ja-en").click();
    await expect(page.locator(".entry .entry-src")).toHaveValue("ミミ");
    await expect(role(page, "glossary-heads")).toContainText("Japanese (as heard)");
  });
});

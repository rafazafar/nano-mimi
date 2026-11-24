import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { emit, ev, reachRunning } from "./ui-harness/driver";

/**
 * Opens the browser's own Document Picture-in-Picture from a real click, which only a headed Chrome allows.
 * Off by default so the suite stays headless: run it with `WEB_E2E_PIP=1 npx playwright test e2e/ui-pip-headed.spec.ts`.
 */
const SCREENS = fileURLToPath(new URL("../.bench/screens/", import.meta.url));

test.skip(process.env["WEB_E2E_PIP"] !== "1", "set WEB_E2E_PIP=1 to run the headed Picture-in-Picture check");
test.use({ headless: false, colorScheme: "dark", viewport: { width: 1280, height: 800 } });

test("the real floating window shows live captions and restores the button when closed", async ({ page, context }) => {
  await mkdir(SCREENS, { recursive: true });
  await reachRunning(page, { pip: "real" });
  await emit(
    page,
    ev.translating(1, 4, "皆さん、おはようございます。"),
    ev.final(1, 4, "皆さん、おはようございます。", "Good morning, everyone."),
    ev.translating(2, 9, "今日は来週のリリースについて話します。"),
    ev.final(2, 9, "今日は来週のリリースについて話します。", "Today we will talk about next week's release."),
    ev.translating(3, 15, "来週の火曜日までに結果を"),
    ev.token(3, "By next Tuesday I will"),
  );
  const button = page.locator('[data-role="pip"]');
  await expect(button).toBeEnabled();

  const known = new Set(context.pages());
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  const isDocumentPip = () => page.evaluate(() => (window as { documentPictureInPicture?: { window?: Window | null } }).documentPictureInPicture?.window != null);
  expect(await isDocumentPip()).toBe(true);

  const pip = await expect
    .poll(() => context.pages().find((candidate) => !known.has(candidate)) ?? null, { timeout: 5000 })
    .not.toBeNull()
    .then(() => context.pages().find((candidate) => !known.has(candidate))!);
  await expect(pip.locator("[data-pip]")).toBeVisible();
  await expect(pip.locator(".pip-provisional-text")).toHaveText("By next Tuesday I will");
  await emit(page, ev.final(3, 15, "来週の火曜日までに結果を", "By next Tuesday I will have the results."));
  await expect(pip.locator('.pip-line[data-age="0"]')).toHaveText("By next Tuesday I will have the results.");
  await pip.setViewportSize({ width: 460, height: 320 });
  await pip.waitForTimeout(500);
  await pip.screenshot({ path: `${SCREENS}ui-pip.png` });

  await pip.close();
  await expect(button).toHaveAttribute("aria-pressed", "false");
  expect(await isDocumentPip()).toBe(false);
});

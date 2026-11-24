import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { emit, ev, expectAppState, openHarness, reachReady, reachRunning, silentWav } from "./ui-harness/driver";

/**
 * Screenshots of every major state in both color schemes, for design review. They land in web/.bench/screens
 * (gitignored); the assertions only guard that each scene really reached the state it is named for.
 */
const role = (page: Page, name: string) => page.locator(`[data-role="${name}"]`);
const SCREENS = fileURLToPath(new URL("../.bench/screens/", import.meta.url));
test.beforeAll(() => mkdir(SCREENS, { recursive: true }));

for (const scheme of ["dark", "light"] as const) {
  test.describe(`screens, ${scheme}`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });

    const shot = async (page: Page, name: string): Promise<void> => {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SCREENS}ui-${name}-${scheme}.png` });
    };

    test("setup: first run", async ({ page }) => {
      await openHarness(page);
      await expectAppState(page, "needs-setup");
      await shot(page, "setup-first-run");
    });

    test("setup: no shader-f16 recommends the CPU backend", async ({ page }) => {
      await openHarness(page, { gpu: "no-f16" });
      await expectAppState(page, "needs-setup");
      await expect(page.locator('.option[data-backend="wasm"] input')).toBeChecked();
      await shot(page, "setup-cpu-recommended");
    });

    test("setup: no WebGPU at all", async ({ page }) => {
      await openHarness(page, { gpu: "none" });
      await expectAppState(page, "needs-setup");
      await shot(page, "setup-no-webgpu");
    });

    test("setup: resume a partial download", async ({ page }) => {
      await openHarness(page, { stored: "partial" });
      await expectAppState(page, "needs-setup");
      await shot(page, "setup-resume");
    });

    test("setup: downloading", async ({ page }) => {
      await openHarness(page);
      await page.locator('[data-role="download"]').click();
      await expectAppState(page, "downloading");
      await page.evaluate(() => window.__harness!.download.progress(0.47));
      await expect(page.locator('.file[data-state="ready"]').first()).toBeVisible();
      await shot(page, "setup-downloading");
    });

    test("setup: storage quota error", async ({ page }) => {
      await openHarness(page);
      await page.evaluate(() => window.__harness!.download.setQuota(true));
      await page.locator('[data-role="download"]').click();
      await expect(page.locator('[data-role="setup-error"]')).toBeVisible();
      await shot(page, "setup-quota");
    });

    test("setup: loading models", async ({ page }) => {
      await openHarness(page, { stored: "all" });
      await expectAppState(page, "loading-engines");
      await page.evaluate(() => {
        const engines = window.__harness!.engines;
        engines.phase("vad", "start");
        engines.phase("vad", "done");
        engines.phase("asr", "start");
      });
      await expect(page.locator('.phase[data-phase="asr"]')).toHaveAttribute("data-status", "loading");
      await shot(page, "setup-loading");
    });

    test("setup: the models failed to load", async ({ page }) => {
      await openHarness(page, { stored: "all" });
      await expectAppState(page, "loading-engines");
      await page.evaluate(() => window.__harness!.engines.fail("The ASR worker ran out of memory."));
      await expectAppState(page, "error");
      await shot(page, "setup-load-failed");
    });

    test("ready", async ({ page }) => {
      await reachReady(page);
      await shot(page, "ready");
    });

    test("ready: tab audio", async ({ page }) => {
      await reachReady(page);
      await page.locator('[data-source="tab"]').check({ force: true });
      await shot(page, "ready-tab");
    });

    test("ready: wav file picked", async ({ page }) => {
      await reachReady(page);
      await page.locator('[data-source="file"]').check({ force: true });
      await page.locator('[data-role="file-input"]').setInputFiles({ name: "standup-2026-11-24.wav", mimeType: "audio/wav", buffer: silentWav(3) });
      await expect(page.locator('[data-role="live-source"]')).toContainText("standup-2026-11-24.wav");
      await shot(page, "ready-file");
    });

    test("ready: microphone refused", async ({ page }) => {
      await reachReady(page);
      await page.evaluate(() => window.__harness!.session.failNextStart("NotAllowedError", "Permission denied"));
      await page.locator('[data-role="start"]').click();
      await expect(page.locator('[data-role="source-error"]')).toBeVisible();
      await shot(page, "ready-mic-refused");
    });

    test("running: listening", async ({ page }) => {
      await reachRunning(page);
      await shot(page, "running-listening");
    });

    test("running: captions", async ({ page }) => {
      await reachRunning(page);
      await emit(
        page,
        ev.translating(1, 4, "皆さん、おはようございます。今日は来週のリリースについて話します。"),
        ev.final(1, 4, "皆さん、おはようございます。今日は来週のリリースについて話します。", "Good morning, everyone. Today we will talk about next week's release."),
        ev.translating(2, 11, "まず、テストの状況を共有します。"),
        ev.final(2, 11, "まず、テストの状況を共有します。", "First, I will share the status of testing.", "mt", 1.1),
        ev.translating(3, 16, "部長には報告しましたが、"),
        ev.final(3, 16, "部長には報告しましたが、", "I reported to the manager, but"),
        ev.translating(4, 20, "来週の火曜日までに結果をまとめます。"),
        ev.token(4, "I will compile the results by"),
        ev.partialJa("そのあとで、", 22),
      );
      await expect(page.locator('[data-draft]')).toBeVisible();
      await shot(page, "running-captions");
    });

    test("running: a line revised in place", async ({ page }) => {
      await reachRunning(page);
      await emit(
        page,
        ev.translating(1, 0, "では、始めましょう。"),
        ev.final(1, 0, "では、始めましょう。", "All right, let's begin."),
        ev.translating(2, 4, "部長には報告しましたが、"),
        ev.final(2, 4, "部長には報告しましたが、", "I reported to the manager, but"),
        ev.revising(2, "部長には報告しましたが、まだ返事がありません。"),
        ev.token(2, "I reported it to the manager, but"),
      );
      await expect(page.locator('.row[data-revising="true"]')).toBeVisible();
      await shot(page, "running-revising");
      await emit(page, ev.revision(2, [3], 4, "部長には報告しましたが、まだ返事がありません。", "I reported it to the manager, but I have not heard back yet."));
      await expect(page.locator('.row[data-row-id="2"] .tag-revised')).toBeVisible();
      await shot(page, "running-revised");
    });

    test("running: behind", async ({ page }) => {
      await reachRunning(page);
      await emit(page, ev.translating(1, 4, "確認します。"), ev.final(1, 4, "確認します。", "I will check."), ev.backlog(6.4, "behind"));
      await expect(page.locator('[data-role="health"]')).toBeVisible();
      await shot(page, "running-behind");
    });

    test("running: overloaded", async ({ page }) => {
      await reachRunning(page);
      await emit(page, ev.translating(1, 4, "確認します。"), ev.final(1, 4, "確認します。", "I will check."), ev.backlog(18, "overloaded"));
      await expect(page.locator('[data-role="health"]')).toHaveAttribute("data-health", "overloaded");
      await shot(page, "running-overloaded");
    });

    test("floating captions window", async ({ page }) => {
      await reachRunning(page);
      await emit(
        page,
        ev.translating(1, 4, "皆さん、おはようございます。"),
        ev.final(1, 4, "皆さん、おはようございます。", "Good morning, everyone."),
        ev.translating(2, 9, "今日は来週のリリースについて話します。"),
        ev.final(2, 9, "今日は来週のリリースについて話します。", "Today we will talk about next week's release."),
        ev.translating(3, 15, "まず、テストの状況を共有します。"),
        ev.final(3, 15, "まず、テストの状況を共有します。", "First, I will share the status of testing."),
        ev.translating(4, 20, "来週の火曜日までに結果を"),
        ev.token(4, "By next Tuesday I will"),
      );
      const opened = page.waitForEvent("popup");
      await role(page, "pip").click();
      const popup = await opened;
      await popup.setViewportSize({ width: 460, height: 320 });
      await expect(popup.locator(".pip-provisional")).toBeVisible();
      await popup.waitForTimeout(400);
      await popup.screenshot({ path: `${SCREENS}ui-pip-fake-${scheme}.png` });
    });

    test("diagnostics open", async ({ page }) => {
      await reachRunning(page);
      await emit(
        page,
        ev.translating(1, 4, "確認します。"),
        ev.final(1, 4, "確認します。", "I will check.", "mt", 0.8),
        ev.translating(2, 8, "お願いします。"),
        ev.final(2, 8, "お願いします。", "Please do.", "mt", 1.2),
      );
      await page.locator('[data-role="diagnostics"] summary').click();
      await expect(page.locator('[data-field="perceived-p50"]')).not.toHaveText("-");
      await page.locator('[data-role="diagnostics"]').scrollIntoViewIfNeeded();
      await shot(page, "diagnostics");
    });

    test("glossary with entries", async ({ page }) => {
      await reachReady(page);
      await page.evaluate(() =>
        localStorage.setItem("mimivox.glossary.v1", JSON.stringify({ version: 1, entries: [{ source: "ミミボックス", target: "MimiVox" }, { source: "かいぎ", target: "会議" }] })),
      );
      await page.reload();
      await expectAppState(page, "loading-engines");
      await shot(page, "glossary");
    });
  });
}

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 844 }, colorScheme: "light" });

  const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  test("setup and downloading fit without sideways scroll", async ({ page }) => {
    await openHarness(page);
    await expectAppState(page, "needs-setup");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SCREENS}ui-phone-setup-light.png` });
    await role(page, "download").click();
    await page.evaluate(() => window.__harness!.download.progress(0.4));
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("ready and running fit without sideways scroll", async ({ page }) => {
    await reachRunning(page);
    await emit(page, ev.translating(1, 4, "皆さん、おはようございます。"), ev.final(1, 4, "皆さん、おはようございます。", "Good morning, everyone."));
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SCREENS}ui-phone-running-light.png` });
  });
});

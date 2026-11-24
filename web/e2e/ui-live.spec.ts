import { expect, test, type Page } from "@playwright/test";
import { emit, ev, expectAppState, reachRunning } from "./ui-harness/driver";

const role = (page: Page, name: string) => page.locator(`[data-role="${name}"]`);
const row = (page: Page, id: number) => page.locator(`.row[data-row-id="${id}"]`);

test.describe("live transcript", () => {
  test("marks the draft and an unfinished row provisional, and a settled row firm", async ({ page }) => {
    await reachRunning(page);
    await expect(role(page, "empty")).toBeVisible();

    await emit(page, ev.partialJa("来週までに", 2), ev.partialEn("By next week", 1));
    const draft = page.locator("[data-draft]");
    await expect(draft).toBeVisible();
    await expect(draft).toHaveAttribute("data-provisional", "true");
    await expect(draft.locator(".row-en")).toHaveText("By next week");
    await expect(draft.locator(".row-ja")).toHaveText("来週までに");
    await expect(role(page, "empty")).toBeHidden();

    await emit(page, ev.translating(1, 2, "来週までに返事をします。"), ev.token(1, "I will reply"));
    await expect(draft).toBeHidden();
    await expect(row(page, 1)).toHaveAttribute("data-provisional", "true");
    await expect(row(page, 1)).toHaveAttribute("data-status", "translating");
    await expect(row(page, 1).locator(".row-en")).toHaveAttribute("data-provisional", "true");
    await expect(row(page, 1).locator(".en-text")).toHaveText("I will reply");

    await emit(page, ev.final(1, 2, "来週までに返事をします。", "I will reply by next week."));
    await expect(row(page, 1)).toHaveAttribute("data-provisional", "false");
    await expect(row(page, 1)).toHaveAttribute("data-status", "settled");
    await expect(row(page, 1).locator(".row-en")).toHaveAttribute("data-provisional", "false");
    await expect(row(page, 1).locator(".en-text")).toHaveText("I will reply by next week.");
    await expect(row(page, 1).locator(".row-time")).toHaveText("00:02");
  });

  test("settled English is visibly firmer than streaming English", async ({ page }) => {
    await reachRunning(page);
    await emit(
      page,
      ev.translating(1, 0, "はい。"),
      ev.final(1, 0, "はい。", "Yes."),
      ev.translating(2, 3, "いいえ。"),
      ev.token(2, "No"),
    );
    const colour = (id: number) => row(page, id).locator(".row-en").evaluate((el) => getComputedStyle(el).color);
    const [firm, dim] = [await colour(1), await colour(2)];
    expect(dim).not.toBe(firm);
    await expect(row(page, 2).locator(".caret")).toBeVisible();
    await expect(row(page, 1).locator(".caret")).toBeHidden();
  });

  test("rewrites a revised row in place and flags it", async ({ page }) => {
    await reachRunning(page);
    await emit(
      page,
      ev.translating(1, 0, "では、始めましょう。"),
      ev.final(1, 0, "では、始めましょう。", "All right, let's begin."),
      ev.translating(2, 4, "部長には報告しましたが、"),
      ev.final(2, 4, "部長には報告しましたが、", "I reported to the manager, but"),
    );
    const target = row(page, 2);
    const handle = await target.elementHandle();
    await expect(page.locator(".row[data-row-id]")).toHaveCount(2);
    await expect(target.locator(".tag-revised")).toBeHidden();

    await emit(page, ev.revising(2, "部長には報告しましたが、まだ返事がありません。"));
    await expect(target).toHaveAttribute("data-revising", "true");
    await expect(target.locator(".tag-revising")).toBeVisible();
    await expect(target.locator(".en-text")).toHaveText("I reported to the manager, but");
    await expect(target.locator(".row-ja")).toHaveText("部長には報告しましたが、まだ返事がありません。");

    await emit(page, ev.revision(2, [3], 4, "部長には報告しましたが、まだ返事がありません。", "I reported to the manager, but I have not heard back yet."));
    await expect(target).toHaveAttribute("data-revising", "false");
    await expect(target).toHaveAttribute("data-revisions", "1");
    await expect(target.locator(".tag-revising")).toBeHidden();
    await expect(target.locator(".tag-revised")).toBeVisible();
    await expect(target.locator(".en-text")).toHaveText("I reported to the manager, but I have not heard back yet.");
    await expect(target).toHaveClass(/flash/);

    expect(await handle!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(page.locator(".row[data-row-id]")).toHaveCount(2);
    await expect(row(page, 1)).not.toHaveClass(/flash/);
  });

  test("a failed revision leaves the line as it was", async ({ page }) => {
    await reachRunning(page);
    await emit(page, ev.translating(1, 0, "確認します、"), ev.final(1, 0, "確認します、", "I will check,"), ev.revising(1, "確認します、すぐに。"));
    await expect(row(page, 1)).toHaveAttribute("data-revising", "true");
    await emit(page, ev.revisionFailed(1));
    await expect(row(page, 1)).toHaveAttribute("data-revising", "false");
    await expect(row(page, 1).locator(".en-text")).toHaveText("I will check,");
  });

  test("the timing detail opens to show the source and every stage", async ({ page }) => {
    await reachRunning(page);
    await emit(page, ev.translating(1, 0, "はい。"), ev.final(1, 0, "はい。", "Yes.", "cache", 0.95));
    const timing = row(page, 1).locator(".timing");
    await expect(timing).not.toHaveAttribute("open", /.*/);
    await expect(timing.locator(".timing-source")).toHaveText("cache");
    await timing.locator("summary").click();
    await expect(timing).toHaveAttribute("open", "");
    await expect(timing.locator(".timing-list")).toContainText("Perceived");
    await expect(timing.locator(".timing-list")).toContainText("0.95 s");
    await expect(timing.locator(".timing-list")).toContainText("cache");
  });

  test("coalesces a burst of tokens into a few DOM writes", async ({ page }) => {
    await reachRunning(page);
    await emit(page, ev.translating(1, 0, "長い文です。"));
    await expect(row(page, 1)).toBeVisible();
    const writes = await page.evaluate(async (token) => {
      const text = document.querySelector('.row[data-row-id="1"] .en-text')!;
      let count = 0;
      const observer = new MutationObserver((records) => {
        count += records.length;
      });
      observer.observe(text, { childList: true, characterData: true, subtree: true });
      for (let i = 0; i < 150; i++) window.__harness!.session.emit(token);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      observer.disconnect();
      return count;
    }, ev.token(1, "w "));
    expect(writes).toBeGreaterThan(0);
    expect(writes).toBeLessThanOrEqual(3);
    await expect(row(page, 1).locator(".en-text")).toHaveText(`${"w ".repeat(150)}`.trim());
  });
});

test.describe("following the live edge", () => {
  test.use({ reducedMotion: "reduce" });

  const fill = (n: number, from = 1) =>
    Array.from({ length: n }, (_, i) => {
      const id = from + i;
      return [ev.translating(id, id * 3, `これは${id}番目の文です。`), ev.final(id, id * 3, `これは${id}番目の文です。`, `This is sentence number ${id}.`)];
    }).flat();

  const atBottom = (page: Page) =>
    role(page, "transcript").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 2);

  test("stays pinned to the newest line, lets go when scrolled up, and jumps back", async ({ page }) => {
    await reachRunning(page);
    await emit(page, ...fill(30));
    await expect.poll(() => atBottom(page)).toBe(true);
    await expect(role(page, "jump")).toBeHidden();

    await role(page, "transcript").evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(role(page, "jump")).toBeVisible();

    await emit(page, ...fill(1, 31));
    await expect(role(page, "jump")).toContainText("1 new");
    expect(await atBottom(page)).toBe(false);

    await role(page, "jump").click();
    await expect(role(page, "jump")).toBeHidden();
    await expect.poll(() => atBottom(page)).toBe(true);

    await emit(page, ...fill(1, 32));
    await expect.poll(() => atBottom(page)).toBe(true);
  });
});

test.describe("behind indicator", () => {
  test("appears only when captions trail, and tells behind from overloaded", async ({ page }) => {
    await reachRunning(page);
    const health = role(page, "health");
    await expect(health).toBeHidden();

    await emit(page, ev.backlog(4.4, "behind"));
    await expect(health).toBeVisible();
    await expect(health).toHaveAttribute("data-health", "behind");
    await expect(health).toHaveText("Behind by 4 s");
    const look = () => health.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, ink: getComputedStyle(el).color }));
    const behind = await look();

    await emit(page, ev.backlog(15, "overloaded"));
    await expect(health).toHaveAttribute("data-health", "overloaded");
    await expect(health).toHaveText("Overloaded, 15 s behind");
    expect(await look()).not.toEqual(behind);

    await emit(page, ev.backlog(0, "ok"));
    await expect(health).toBeHidden();
  });
});

test.describe("floating captions", () => {
  test("opens from a click, follows the same captions, and restores the button when closed", async ({ page }) => {
    await reachRunning(page);
    await emit(page, ev.translating(1, 1, "おはようございます。"), ev.final(1, 1, "おはようございます。", "Good morning."));
    const button = role(page, "pip");
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute("aria-pressed", "false");

    const popupOpened = page.waitForEvent("popup");
    await button.click();
    const popup = await popupOpened;
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(button).toContainText("Close floating captions");
    await expect(popup.locator("[data-pip]")).toBeVisible();
    await expect(popup.locator('.pip-line[data-age="0"]')).toHaveText("Good morning.");

    await emit(page, ev.translating(2, 4, "今日は晴れです。"), ev.token(2, "It is"));
    await expect(popup.locator(".pip-provisional")).toBeVisible();
    await expect(popup.locator(".pip-provisional-text")).toHaveText("It is");
    await emit(page, ev.final(2, 4, "今日は晴れです。", "It is sunny today."));
    await expect(popup.locator('.pip-line[data-age="0"]')).toHaveText("It is sunny today.");
    await expect(popup.locator('.pip-line[data-age="1"]')).toHaveText("Good morning.");

    await emit(page, ev.backlog(7, "behind"));
    await expect(popup.locator(".pip-health")).toHaveText("Behind by 7 s");

    await popup.close();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(button).toContainText("Floating captions");
    await expect(role(page, "pip-note")).toBeHidden();

    const again = page.waitForEvent("popup");
    await button.click();
    const second = await again;
    await expect(second.locator('.pip-line[data-age="0"]')).toHaveText("It is sunny today.");
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
  });

  test("keeps updating while the opener tab is in the background", async ({ page, context }) => {
    await reachRunning(page);
    const popupOpened = page.waitForEvent("popup");
    await role(page, "pip").click();
    const popup = await popupOpened;
    const other = await context.newPage();
    await other.goto("about:blank");
    await other.bringToFront();

    await emit(page, ev.translating(1, 1, "テストです。"), ev.final(1, 1, "テストです。", "This is a test."));
    await expect(popup.locator('.pip-line[data-age="0"]')).toHaveText("This is a test.");
    await other.close();
  });

  test("a refused window is a message beside the button, and a second press works", async ({ page }) => {
    await reachRunning(page);
    await page.evaluate(() => {
      window.__harness!.pip.denyNext = true;
    });
    await role(page, "pip").click();
    await expect(role(page, "pip-note")).toContainText("straight from a click");
    await expect(role(page, "pip")).toBeEnabled();
    await expect(role(page, "pip")).toHaveAttribute("aria-pressed", "false");

    const popupOpened = page.waitForEvent("popup");
    await role(page, "pip").click();
    await popupOpened;
    await expect(role(page, "pip")).toHaveAttribute("aria-pressed", "true");
    await expect(role(page, "pip-note")).toBeHidden();
  });

  test("stopping the session leaves the floating window open", async ({ page }) => {
    await reachRunning(page);
    const popupOpened = page.waitForEvent("popup");
    await role(page, "pip").click();
    await popupOpened;
    await role(page, "start").click();
    await expectAppState(page, "ready");
    await expect(role(page, "pip")).toHaveAttribute("aria-pressed", "true");
  });
});

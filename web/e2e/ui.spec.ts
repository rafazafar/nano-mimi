import { expect, test, type Page } from "@playwright/test";
import { emit, ev, expectAppState, openHarness, reachReady, reachRunning, silentWav } from "./ui-harness/driver";

const role = (page: Page, name: string) => page.locator(`[data-role="${name}"]`);
const BACKEND_KEY = "mimivox.asr-backend.v1";
const GLOSSARY_KEY = "mimivox.glossary.v1";
const THEME_KEY = "mimivox.theme.v1";

test.describe("first-run setup", () => {
  test("downloads, loads the engines and reaches Ready", async ({ page }) => {
    await openHarness(page);
    await expectAppState(page, "needs-setup");
    await expect(page.locator('[data-role="checks"] .check[data-ok="true"]')).toHaveCount(1);
    await expect(page.locator('.option[data-backend="webgpu"] input')).toBeChecked();
    await expect(role(page, "download")).toHaveText(/^Download \d/);
    await expect(role(page, "overall")).toHaveAttribute("data-state", "needs-download");

    await role(page, "download").click();
    await expectAppState(page, "downloading");
    await expect(role(page, "pause")).toBeVisible();
    await expect(page.locator('.option input[value="wasm"]')).toBeDisabled();

    await page.evaluate(() => window.__harness!.download.progress(0.5));
    await expect(role(page, "overall")).toHaveAttribute("data-state", "downloading");
    await expect(role(page, "overall")).toHaveText(/ of /);
    await expect(page.locator('.file[data-state="ready"]').first()).toBeVisible();
    await expect(page.locator('.file[data-state="partial"]').first()).toContainText(/of/);
    await expect(page.locator('[data-role="status-label"]')).toHaveText(/^Downloading \d+%$/);

    await page.evaluate(() => window.__harness!.download.finish());
    await expectAppState(page, "loading-engines");
    await page.evaluate(() => {
      window.__harness!.engines.phase("vad", "start");
      window.__harness!.engines.phase("vad", "done");
      window.__harness!.engines.phase("asr", "start");
    });
    await expect(page.locator('.phase[data-phase="vad"]')).toHaveAttribute("data-status", "done");
    await expect(page.locator('.phase[data-phase="asr"]')).toHaveAttribute("data-status", "loading");
    await expect(page.locator('.phase[data-phase="mt"]')).toHaveAttribute("data-status", "pending");
    await expect(role(page, "load-elapsed")).toContainText("Loading for");

    await page.evaluate(() => {
      window.__harness!.engines.phase("asr", "done");
      window.__harness!.engines.phase("mt", "start");
      window.__harness!.engines.phase("mt", "done");
      window.__harness!.engines.finish();
    });
    await expectAppState(page, "ready");
    await expect(role(page, "empty")).toContainText("Models loaded in 9.09 s");
    await expect(role(page, "start")).toBeEnabled();
  });

  test("skips the download when every file is already verified", async ({ page }) => {
    await openHarness(page, { stored: "all" });
    await expectAppState(page, "loading-engines");
    await expect(role(page, "models")).toBeHidden();
    await expect(role(page, "download")).toBeHidden();
    await expect(role(page, "engines")).toBeVisible();
  });

  test("offers to resume a partial download", async ({ page }) => {
    await openHarness(page, { stored: "partial" });
    await expectAppState(page, "needs-setup");
    await expect(role(page, "download")).toHaveText(/^Resume download, .+ left$/);
  });

  test("recommends the CPU backend without shader-f16 and remembers an override", async ({ page }) => {
    await openHarness(page, { gpu: "no-f16" });
    await expectAppState(page, "needs-setup");
    await expect(page.locator('.option[data-backend="wasm"] input')).toBeChecked();
    await expect(page.locator('.option[data-backend="wasm"] .tag-ok')).toHaveText("Recommended here");
    await expect(page.locator('[data-role="checks"] .check[data-code="no-shader-f16"]')).toBeVisible();

    await page.locator('.option[data-backend="webgpu"]').click();
    await expect(page.locator('.option[data-backend="webgpu"] input')).toBeChecked();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), BACKEND_KEY)).toBe("webgpu");

    await page.reload();
    await expectAppState(page, "needs-setup");
    await expect(page.locator('.option[data-backend="webgpu"] input')).toBeChecked();

    await page.locator('.option[data-backend="wasm"]').click();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), BACKEND_KEY)).toBeNull();
  });

  test("shows the endpoint parameter, and ignores one it cannot trust", async ({ page }) => {
    await openHarness(page, { endpoint: "https://mirror.example.com/hf/" });
    await expectAppState(page, "needs-setup");
    await expect(role(page, "endpoint")).toHaveAttribute("data-kind", "custom");
    await expect(role(page, "endpoint")).toContainText("https://mirror.example.com/hf");

    await openHarness(page, { endpoint: "javascript:alert(1)" });
    await expectAppState(page, "needs-setup");
    await expect(role(page, "endpoint")).toHaveAttribute("data-kind", "invalid");
    await expect(role(page, "endpoint")).toContainText("was ignored");
  });

  test("shows the storage quota error verbatim and recovers on retry", async ({ page }) => {
    await openHarness(page);
    await page.evaluate(() => window.__harness!.download.setQuota(true));
    await role(page, "download").click();
    await expect(role(page, "setup-error")).toContainText("Not enough browser storage");
    await expect(role(page, "setup-error")).toContainText("Free disk space or clear site data");
    await expectAppState(page, "needs-setup");
    await expect(role(page, "download")).toBeEnabled();

    await page.evaluate(() => window.__harness!.download.setQuota(false));
    await role(page, "download").click();
    await expectAppState(page, "downloading");
    await expect(role(page, "setup-error")).toBeHidden();
  });

  test("keeps progress when a file fails and resumes from it", async ({ page }) => {
    await openHarness(page);
    await role(page, "download").click();
    await page.evaluate(() => window.__harness!.download.progress(0.3));
    await page.evaluate(() => window.__harness!.download.fail("connection reset"));
    await expectAppState(page, "needs-setup");
    await expect(role(page, "setup-error")).toContainText("connection reset");
    await expect(page.locator('.file[data-state="failed"]')).toHaveCount(1);
    await expect(role(page, "download")).toHaveText(/^Try again, .+ left$/);

    await role(page, "download").click();
    await expectAppState(page, "downloading");
    await page.evaluate(() => window.__harness!.download.finish());
    await expectAppState(page, "loading-engines");
  });

  test("pauses a download without calling it an error", async ({ page }) => {
    await openHarness(page);
    await role(page, "download").click();
    await page.evaluate(() => window.__harness!.download.progress(0.4));
    await role(page, "pause").click();
    await expectAppState(page, "needs-setup");
    await expect(role(page, "setup-error")).toBeHidden();
    await expect(role(page, "download")).toHaveText(/^Resume download/);
  });

  test("a failed engine load can be retried", async ({ page }) => {
    await openHarness(page, { stored: "all" });
    await expectAppState(page, "loading-engines");
    await page.evaluate(() => window.__harness!.engines.fail("The ASR worker ran out of memory."));
    await expectAppState(page, "error");
    await expect(role(page, "fatal-error")).toContainText("ran out of memory");

    await role(page, "retry").click();
    await expectAppState(page, "loading-engines");
    await page.evaluate(() => window.__harness!.engines.finish());
    await expectAppState(page, "ready");
  });
});

test.describe("source picker and start", () => {
  test("a blocked microphone is an inline message and Start works again", async ({ page }) => {
    await reachReady(page);
    await page.evaluate(() => window.__harness!.session.failNextStart("NotAllowedError", "Permission denied"));
    await role(page, "start").click();
    await expect(role(page, "source-error")).toContainText("Microphone access was blocked");
    await expectAppState(page, "ready");
    await expect(role(page, "start")).toBeEnabled();

    await role(page, "start").click();
    await expectAppState(page, "running");
    await expect(role(page, "source-error")).toBeHidden();
    await expect(role(page, "start")).toHaveText("Stop");
  });

  test("browser/system audio is the default where the browser can capture it, the mic elsewhere", async ({ page }) => {
    await reachReady(page, { tab: "1" });
    await expect(page.locator("label.seg", { hasText: "Browser / system audio" }).locator("input")).toBeChecked();
    await reachReady(page);
    await expect(page.locator("label.seg", { hasText: "Microphone" }).locator("input")).toBeChecked();
  });

  test("tab audio explains how to share sound, and a share without audio is recoverable", async ({ page }) => {
    await reachReady(page);
    await page.locator("label.seg", { hasText: "Browser / system audio" }).click();
    await expect(role(page, "source-hint")).toContainText("entire screen");

    await role(page, "start").click();
    await expect(role(page, "share-guide")).toContainText("Share tab audio");
    await role(page, "share-guide").getByRole("button", { name: "Cancel" }).click();
    await expect(role(page, "share-guide")).toBeHidden();
    await expectAppState(page, "ready");

    await page.evaluate(() => window.__harness!.session.failNextStart("Error", "The shared tab has no audio track"));
    await role(page, "start").click();
    await role(page, "share-continue").click();
    await expect(role(page, "source-error")).toContainText("Share tab audio");
    await expectAppState(page, "ready");

    await role(page, "start").click();
    await role(page, "share-continue").click();
    await expectAppState(page, "running");
    expect(await page.evaluate(() => window.__harness!.session.startedWith)).toEqual({ kind: "tab" });
  });

  test("a WAV chosen with the picker is replayed, and Stop is not needed when it ends", async ({ page }) => {
    await reachReady(page);
    await page.locator("label.seg", { hasText: "WAV file" }).click();
    await expect(role(page, "start")).toBeDisabled();
    await role(page, "file-input").setInputFiles({ name: "standup.wav", mimeType: "audio/wav", buffer: silentWav(2) });
    await expect(role(page, "live-source")).toHaveText("standup.wav");
    await expect(role(page, "start")).toBeEnabled();

    await role(page, "start").click();
    await expectAppState(page, "running");
    const started = await page.evaluate(() => window.__harness!.session.startedWith);
    expect(started).toMatchObject({ kind: "file", name: "standup.wav" });

    await page.evaluate(() => window.__harness!.session.end());
    await expectAppState(page, "ready");
  });

  test("a file that is not a WAV is refused inline", async ({ page }) => {
    await reachReady(page);
    await page.locator("label.seg", { hasText: "WAV file" }).click();
    await role(page, "file-input").setInputFiles({ name: "notes.wav", mimeType: "audio/wav", buffer: Buffer.from("not audio at all") });
    await expect(role(page, "source-error")).toContainText("notes.wav");
    await expect(role(page, "start")).toBeDisabled();
  });

  test("a WAV dropped on the page is picked up", async ({ page }) => {
    await reachReady(page);
    const bytes = [...silentWav(1)];
    await page.evaluate((data) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(data)], "dropped.wav", { type: "audio/wav" }));
      const fire = (type: string) => document.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
      fire("dragenter");
      fire("dragover");
      fire("drop");
    }, bytes);
    await expect(page.locator('[data-source="file"]')).toBeChecked();
    await expect(role(page, "live-source")).toHaveText("dropped.wav");
    await expect(role(page, "drop")).toBeHidden();
  });

  test("Stop returns to Ready and clears a stale behind indicator", async ({ page }) => {
    await reachRunning(page);
    await emit(page, ev.backlog(9, "behind"));
    await expect(role(page, "health")).toBeVisible();
    await role(page, "start").click();
    await expectAppState(page, "ready");
    await expect(role(page, "health")).toBeHidden();
  });
});

test.describe("glossary", () => {
  test("entries persist across a reload in insertion order and are told apart by kind", async ({ page }) => {
    await openHarness(page);
    const form = role(page, "add-entry");
    const add = async (source: string, target: string) => {
      await form.locator('input[name="source"]').fill(source);
      await form.locator('input[name="target"]').fill(target);
      await form.locator('button[type="submit"]').click();
    };
    await form.locator('input[name="target"]').fill("MimiVox");
    await expect(role(page, "kind-hint")).toContainText("Term");
    await form.locator('input[name="target"]').fill("ミミボックス");
    await expect(role(page, "kind-hint")).toContainText("Spelling fix");
    await form.locator('input[name="target"]').fill("");

    await add("ミミボックス", "MimiVox");
    await add("みみぼっくす", "ミミボックス");
    await add("かいぎ", "meeting");
    await expect(page.locator(".entry")).toHaveCount(3);
    await expect(page.locator(".entry").nth(0)).toHaveAttribute("data-kind", "term");
    await expect(page.locator(".entry").nth(1)).toHaveAttribute("data-kind", "asr-fix");

    const stored = await page.evaluate((key) => localStorage.getItem(key), GLOSSARY_KEY);
    expect(JSON.parse(stored ?? "null")).toEqual({
      version: 1,
      entries: [
        { source: "ミミボックス", target: "MimiVox" },
        { source: "みみぼっくす", target: "ミミボックス" },
        { source: "かいぎ", target: "meeting" },
      ],
    });

    await page.reload();
    await expect(page.locator(".entry")).toHaveCount(3);
    expect(await page.locator(".entry-src").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(["ミミボックス", "みみぼっくす", "かいぎ"]);
    expect(await page.locator(".entry-dst").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(["MimiVox", "ミミボックス", "meeting"]);

    await page.locator(".entry").nth(1).locator('[data-role="remove"]').click();
    await expect(page.locator(".entry")).toHaveCount(2);
    await page.reload();
    await expect(page.locator(".entry")).toHaveCount(2);
  });

  test("rejects an empty entry with a message and keeps what is saved", async ({ page }) => {
    await openHarness(page);
    const form = role(page, "add-entry");
    await form.locator('button[type="submit"]').click();
    await expect(role(page, "glossary-error")).toBeVisible();
    await expect(page.locator(".entry")).toHaveCount(0);
  });

  test("a corrupt saved glossary is ignored and replaced on the next edit", async ({ page }) => {
    await openHarness(page);
    await page.evaluate((key) => localStorage.setItem(key, "{not json"), GLOSSARY_KEY);
    await page.reload();
    await expectAppState(page, "needs-setup");
    await expect(page.locator(".entry")).toHaveCount(0);
    await expect(role(page, "glossary-empty")).toBeVisible();

    const form = role(page, "add-entry");
    await form.locator('input[name="source"]').fill("かいぎ");
    await form.locator('input[name="target"]').fill("meeting");
    await form.locator('button[type="submit"]').click();
    const stored = await page.evaluate((key) => localStorage.getItem(key), GLOSSARY_KEY);
    expect(JSON.parse(stored ?? "null")).toMatchObject({ version: 1, entries: [{ source: "かいぎ", target: "meeting" }] });
  });

  test("keeps the valid entries when only some saved ones are damaged", async ({ page }) => {
    await openHarness(page);
    await page.evaluate(
      (key) =>
        localStorage.setItem(
          key,
          JSON.stringify({ version: 1, entries: [{ source: "かいぎ", target: "meeting" }, { source: 5, target: "x" }, { source: "かいぎ", target: "again" }, { source: "てすと", target: "test" }] }),
        ),
      GLOSSARY_KEY,
    );
    await page.reload();
    await expect(page.locator(".entry")).toHaveCount(2);
  });

  test("the running session reads edits live, with the first duplicate winning", async ({ page }) => {
    await reachRunning(page);
    expect(await page.evaluate(() => window.__harness!.session.readGlossary())).toEqual([]);
    const form = role(page, "add-entry");
    await form.locator('input[name="source"]').fill("かいぎ");
    await form.locator('input[name="target"]').fill("meeting");
    await form.locator('button[type="submit"]').click();
    await form.locator('input[name="source"]').fill("ミミボックス");
    await form.locator('input[name="target"]').fill("MimiVox");
    await form.locator('button[type="submit"]').click();
    expect(await page.evaluate(() => window.__harness!.session.readGlossary())).toEqual([
      ["かいぎ", "meeting"],
      ["ミミボックス", "MimiVox"],
    ]);
  });
});

test.describe("theme", () => {
  test.use({ colorScheme: "dark" });

  test("follows the system and remembers a manual choice", async ({ page }) => {
    await openHarness(page);
    const html = page.locator("html");
    await expect(html).not.toHaveAttribute("data-theme", /.*/);
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const dark = await bg();

    await role(page, "theme").click();
    await expect(html).toHaveAttribute("data-theme", "light");
    expect(await bg()).not.toBe(dark);
    expect(await page.evaluate((key) => localStorage.getItem(key), THEME_KEY)).toBe("light");

    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "light");

    await role(page, "theme").click();
    await expect(html).not.toHaveAttribute("data-theme", /.*/);
    expect(await page.evaluate((key) => localStorage.getItem(key), THEME_KEY)).toBeNull();
    expect(await bg()).toBe(dark);
  });
});

test.describe("diagnostics", () => {
  test("is collapsed until opened, then shows the runtime facts and latency", async ({ page }) => {
    await reachRunning(page);
    const panel = role(page, "diagnostics");
    await expect(panel).not.toHaveAttribute("open", /.*/);
    await emit(
      page,
      ev.translating(1, 1, "はい。"),
      ev.final(1, 1, "はい。", "Yes.", "mt", 0.8),
      ev.translating(2, 3, "いいえ。"),
      ev.final(2, 3, "いいえ。", "No.", "mt", 1.2),
    );
    await panel.locator("summary").click();
    await expect(panel).toHaveAttribute("open", "");
    const field = (name: string) => panel.locator(`[data-field="${name}"]`);
    await expect(field("vendor")).toHaveText("apple");
    await expect(field("crossOriginIsolated")).toHaveText(/^(true|false)$/);
    await expect(field("asr-backend")).toHaveText("webgpu");
    await expect(field("mt-runtime")).not.toHaveText("-");
    await expect(field("load-total")).toHaveText("9.09 s");
    await expect(field("perceived-count")).toHaveText("2");
    await expect(field("perceived-p50")).toHaveText("1.00 s");
    await expect(field("perceived-p95")).toHaveText("1.18 s");
  });
});

test.describe("without Document Picture-in-Picture", () => {
  test("the floating captions control is off with a one-line reason and the rest still works", async ({ page }) => {
    await reachReady(page, { pip: "none" });
    await expect(role(page, "pip")).toBeDisabled();
    await expect(role(page, "pip-note")).toBeVisible();
    await expect(role(page, "pip-note")).toContainText("Chrome or Edge");

    await role(page, "start").click();
    await expectAppState(page, "running");
    await emit(page, ev.translating(1, 1, "はい。"), ev.final(1, 1, "はい。", "Yes."));
    await expect(page.locator('.row[data-row-id="1"] .row-en')).toContainText("Yes.");
  });
});

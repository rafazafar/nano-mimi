import { expect, test } from "@playwright/test";

test("the app's diagnostics panel reports a hardware WebGPU adapter", async ({ page }) => {
  await page.goto("/");
  const diagnostics = page.locator('[data-role="diagnostics"]');
  await expect(diagnostics).not.toHaveAttribute("open", "");
  await diagnostics.locator("summary").click();
  await expect(diagnostics).toHaveAttribute("open", "");

  const status = page.locator("#gpu-status");
  await expect(status).not.toHaveAttribute("data-state", "pending");
  await expect(status).toHaveAttribute("data-state", "ready");

  const field = (name: string) => page.locator(`#gpu-details [data-field="${name}"]`);
  await expect(field("vendor")).not.toBeEmpty();
  await expect(field("fallback adapter")).toHaveText("false");
  await expect(field("maxBufferSize")).not.toBeEmpty();
  await expect(field("shader-f16")).toHaveText(/^(true|false)$/);
});

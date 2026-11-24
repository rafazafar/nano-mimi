import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ModelServer } from "./model-server";

const SIZE = 50 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;
const FILE = "acme/tiny/resolve/main/weights.bin";

const server = ModelServer.withRandomFile(FILE, SIZE, 12 * 1024 * 1024);
test.beforeAll(() => server.start());
test.afterAll(() => server.stop());

async function routeManifest(context: BrowserContext): Promise<void> {
  const file = server.files[0]!;
  const manifest = {
    models: [
      {
        id: "tiny",
        label: "Tiny test model",
        repo: "acme/tiny",
        revision: "main",
        files: [{ path: "weights.bin", url: `${server.origin}/${FILE}`, size: SIZE, sha256: file.sha256 }],
      },
    ],
  };
  await context.route((u) => u.pathname === "/test-manifest.json", (r) => r.fulfill({ json: manifest }));
}

const SETUP = "/setup.html?manifest=/test-manifest.json";
const overall = (page: Page) => page.locator("#overall");

async function receivedBytes(page: Page): Promise<number> {
  return page.locator("li[data-path] progress").evaluate((p) => (p as HTMLProgressElement).value);
}

test("download resumes after the tab dies, then loads offline with zero requests", async ({ page, context, baseURL }) => {
  test.setTimeout(120_000);
  await routeManifest(context);

  await page.goto(SETUP);
  await expect(overall(page)).toHaveAttribute("data-state", "needs-download");
  await page.locator("#download").click();
  await expect.poll(() => receivedBytes(page), { timeout: 30_000 }).toBeGreaterThan(SIZE * 0.4);
  await page.close();

  const before = server.requests.length;
  expect(server.requests[before - 1]!.range).toBeNull();

  const reopened = await context.newPage();
  await reopened.goto(SETUP);
  await expect(overall(reopened)).toHaveAttribute("data-state", "needs-download");
  await expect(reopened.locator("li[data-path]")).toHaveAttribute("data-state", "partial");
  await reopened.locator("#download").click();
  await expect(overall(reopened)).toHaveAttribute("data-state", "ready", { timeout: 60_000 });

  const resume = server.requests[before]!;
  const start = Number(/bytes=(\d+)-/.exec(resume.range ?? "")?.[1]);
  console.log(`resume request: ${resume.range}`);
  expect(start).toBeGreaterThan(0);
  expect(start % CHUNK).toBe(0);
  expect(start).toBeLessThan(SIZE);
  expect(server.requests).toHaveLength(before + 1);
  await reopened.close();

  // Cold page load straight to ready, from OPFS.
  const cold = await context.newPage();
  const count = server.requests.length;
  await cold.goto(SETUP);
  await expect(overall(cold)).toHaveAttribute("data-state", "ready");
  const readyMs = Number(await cold.locator("#ready-ms").textContent());
  const readMs = await cold.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const t0 = performance.now();
    let n = 0;
    const walk = async (d: FileSystemDirectoryHandle): Promise<void> => {
      for await (const e of d.values()) {
        if (e.kind === "directory") await walk(e as FileSystemDirectoryHandle);
        else if (e.name !== "verified") n += (await (await (e as FileSystemFileHandle).getFile()).arrayBuffer()).byteLength;
      }
    };
    await walk(root);
    return { ms: performance.now() - t0, bytes: n };
  });
  console.log(`PERF cold load to ready (50 MB, OPFS): ${readyMs} ms; reading all bytes back: ${readMs.ms.toFixed(0)} ms (${readMs.bytes} bytes)`);
  expect(server.requests).toHaveLength(count);
  await cold.close();

  // Offline reload: the app shell is fulfilled by Playwright, everything else is cut.
  await context.route(`${baseURL}/**`, async (r) =>
    new URL(r.request().url()).pathname === "/test-manifest.json" ? r.fallback() : r.fulfill({ response: await r.fetch() }),
  );
  await context.setOffline(true);
  const offline = await context.newPage();
  await offline.goto(SETUP);
  await expect(overall(offline)).toHaveAttribute("data-state", "ready");
  await offline.reload();
  await expect(overall(offline)).toHaveAttribute("data-state", "ready");
  expect(server.requests).toHaveLength(count);
});

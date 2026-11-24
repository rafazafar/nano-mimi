import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { readFixture } from "../src/test/fixtures";

interface WavFixture {
  readonly utterances: readonly { start: number; end: number; emitted: boolean }[];
}

const WAV = fileURLToPath(new URL("../../data/fixtures/meeting-recording.wav", import.meta.url));
const SAMPLE_RATE = 16_000;
const WINDOW = 512;
const WAV_SECONDS = 589_143 / SAMPLE_RATE;
const expected = readFixture<WavFixture>("vad/meeting-recording.json").utterances.filter(
  (u) => u.emitted,
);

test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-webgpu",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${WAV}%noloop`,
    ],
  },
});

test.beforeAll(() => {
  if (!existsSync(WAV)) throw new Error(`${WAV} is missing. Run \`make fixture\` first.`);
});

async function utterances(page: Page): Promise<{ start: number; end: number }[]> {
  return page.locator("#utterances tr").evaluateAll((trs) =>
    trs.map((tr) => ({
      start: Number((tr as HTMLElement).dataset["startSample"]),
      end: Number((tr as HTMLElement).dataset["endSample"]),
    })),
  );
}

test("a WAV file yields the utterances the Python VAD cut, to the sample", async ({ page }) => {
  await page.goto("/vad.html");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.locator("#wav-file").setInputFiles(WAV);
  await expect(page.locator("#status")).toHaveAttribute("data-state", "done");
  expect(await utterances(page)).toEqual(expected.map(({ start, end }) => ({ start, end })));
});

test("microphone fed by Chrome's fake capture device lists the fixture's utterances and keeps the worklet inside its render budget", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/vad.html");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
  await page.locator("#start-mic").click();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "listening");
  await page.waitForTimeout((WAV_SECONDS + 3) * 1000);

  const stats = (await page.locator("#worklet-stats").textContent()) ?? "";
  await page.locator("#stop").click();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "stopped");

  const live = await utterances(page);
  console.log(`live utterances: ${JSON.stringify(live)}`);
  console.log(`fixture utterances: ${JSON.stringify(expected)}`);
  console.log(stats);

  expect(live).toHaveLength(expected.length);
  const shifts = live.map((u, i) => u.start - expected[i]!.start).sort((a, b) => a - b);
  const shift = shifts[Math.floor(shifts.length / 2)]!;
  console.log(`capture start shift: ${shift} samples`);
  expect(shift).toBeLessThanOrEqual(0);
  expect(shift).toBeGreaterThan(-SAMPLE_RATE);
  live.forEach((u, i) => {
    const e = expected[i]!;
    expect(Math.abs(u.start - e.start - shift), `start of #${i + 1}`).toBeLessThanOrEqual(
      2 * WINDOW,
    );
    expect(Math.abs(u.end - e.end - shift), `end of #${i + 1}`).toBeLessThanOrEqual(2 * WINDOW);
  });
  const field = (pattern: RegExp) => Number(pattern.exec(stats)?.[1]);
  expect(field(/(\d+) quanta/)).toBeGreaterThan(1000);
  expect(field(/slow calls (\d+)/) / field(/(\d+) quanta/)).toBeLessThan(0.01);
  expect(field(/skipped (\d+)/)).toBe(0);
});

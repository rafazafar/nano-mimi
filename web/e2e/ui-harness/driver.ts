import { expect, type Page } from "@playwright/test";
import { asEnText, asJaText } from "../../src/core/types";
import { asRowId, type EnSource, type Health, type PipelineEvent, type Timing } from "../../src/pipeline/types";

export const HARNESS = "/e2e/ui-harness/index.html";

export type HarnessParams = Readonly<Record<string, string>>;

export async function openHarness(page: Page, params: HarnessParams = {}): Promise<void> {
  const query = new URLSearchParams(params).toString();
  await page.goto(query === "" ? HARNESS : `${HARNESS}?${query}`);
  await page.waitForFunction(() => window.__harness !== undefined);
}

export const appState = (page: Page) => page.locator('[data-role="shell"]');

export async function expectAppState(page: Page, kind: string): Promise<void> {
  await expect(appState(page)).toHaveAttribute("data-app-state", kind);
}

/** Opens the page with everything on disk, finishes the engine load, and waits for Ready. */
export async function reachReady(page: Page, params: HarnessParams = {}): Promise<void> {
  await openHarness(page, { stored: "all", ...params });
  await expectAppState(page, "loading-engines");
  await page.evaluate(() => {
    const engines = window.__harness!.engines;
    engines.phase("vad", "start");
    engines.phase("vad", "done");
    engines.phase("asr", "start");
    engines.phase("asr", "done");
    engines.phase("mt", "start");
    engines.phase("mt", "done");
    engines.finish();
  });
  await expectAppState(page, "ready");
}

/** Ready, then Start on the microphone, and wait for Running. */
export async function reachRunning(page: Page, params: HarnessParams = {}): Promise<void> {
  await reachReady(page, params);
  await page.locator('[data-role="start"]').click();
  await expectAppState(page, "running");
}

export function emit(page: Page, ...events: readonly PipelineEvent[]): Promise<void> {
  return page.evaluate((list) => window.__harness!.session.emit(...list), events);
}

export const timing = (perceivedS = 0.95): Timing => ({ vadWaitS: 0.4, queueWaitS: 0.05, asrS: 0.2, mtS: perceivedS - 0.65, perceivedS, endToEndS: perceivedS + 0.25 });

export const ev = {
  partialJa: (ja: string, timelineS: number): PipelineEvent => ({ kind: "partial_ja", ja: asJaText(ja), timelineS }),
  partialEn: (en: string, version: number, complete = false): PipelineEvent => ({ kind: "partial_en", en: asEnText(en), version, complete }),
  translating: (id: number, timelineS: number, ja: string): PipelineEvent => ({ kind: "translating", id: asRowId(id), timelineS, ja: asJaText(ja) }),
  token: (id: number, delta: string): PipelineEvent => ({ kind: "en_token", id: asRowId(id), delta }),
  final: (id: number, timelineS: number, ja: string, en: string, source: EnSource = "mt", perceivedS = 0.95): PipelineEvent => ({
    kind: "final",
    id: asRowId(id),
    timelineS,
    durationS: 2.4,
    ja: asJaText(ja),
    en: asEnText(en),
    source,
    timing: timing(perceivedS),
  }),
  revising: (targetId: number, ja: string): PipelineEvent => ({ kind: "revising", targetId: asRowId(targetId), ja: asJaText(ja) }),
  revision: (targetId: number, mergedIds: readonly number[], timelineS: number, ja: string, en: string): PipelineEvent => ({
    kind: "revision",
    targetId: asRowId(targetId),
    mergedIds: mergedIds.map(asRowId),
    timelineS,
    durationS: 5.1,
    ja: asJaText(ja),
    en: asEnText(en),
    source: "mt",
    timing: timing(1.4),
  }),
  revisionFailed: (targetId: number): PipelineEvent => ({ kind: "revision_failed", targetId: asRowId(targetId) }),
  backlog: (backlogS: number, health: Health): PipelineEvent => ({ kind: "backlog", backlogS, health }),
};

/** A short mono 16-bit PCM WAV: enough for the picker's checks, no speech. */
export function silentWav(seconds = 1, sampleRate = 16000): Buffer {
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i / 20) * 400), i * 2);
  return Buffer.concat([header, data]);
}

import { describe, expect, it } from "vitest";
import { asEnText } from "../core/types";
import type { MtResult } from "./protocol";
import { MtScheduler, type Job, type RunJob } from "./scheduler";

const result = (en: string): MtResult => ({
  en: asEnText(en),
  raw: en,
  promptLeak: false,
  japaneseStripped: false,
  numbersMismatch: false,
  attempts: [],
  kept: 0,
  totalMs: 0,
});

/** A runner whose jobs finish when the test says so, or reject on abort. */
function controllable() {
  const pending = new Map<number, { resolve: (r: MtResult) => void; token: (d: string) => void }>();
  const started: number[] = [];
  const run: RunJob = (job, signal, onToken) =>
    new Promise((resolve, reject) => {
      started.push(job.id);
      pending.set(job.id, { resolve, token: onToken });
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  return { run, started, finish: (id: number, en: string) => pending.get(id)!.resolve(result(en)), token: (id: number, d: string) => pending.get(id)!.token(d) };
}

const job = (id: number, preview: boolean): Job => ({ id, ja: `ja${id}`, context: [], preview });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("MtScheduler", () => {
  it("runs one job and reports its tokens and result", async () => {
    const r = controllable();
    const events: unknown[] = [];
    const s = new MtScheduler(r.run, (e) => events.push(e));
    s.submit(job(1, false));
    r.token(1, "Hel");
    r.finish(1, "Hello");
    await tick();
    expect(events).toEqual([{ type: "token", id: 1, delta: "Hel" }, { type: "done", id: 1, result: result("Hello") }]);
  });

  it("aborts a running preview when a final arrives, then runs the final", async () => {
    const r = controllable();
    const events: { type: string; id: number }[] = [];
    const s = new MtScheduler(r.run, (e) => events.push(e));
    s.submit(job(1, true));
    s.submit(job(2, false));
    await tick();
    expect(events).toEqual([{ type: "cancelled", id: 1 }]);
    expect(r.started).toEqual([1, 2]);
    r.finish(2, "final");
    await tick();
    expect(events.at(-1)).toMatchObject({ type: "done", id: 2 });
  });

  it("skips a preview while a final runs or waits", async () => {
    const r = controllable();
    const events: { type: string; id: number }[] = [];
    const s = new MtScheduler(r.run, (e) => events.push(e));
    s.submit(job(1, false));
    s.submit(job(2, true));
    expect(events).toEqual([{ type: "skipped", id: 2 }]);
    expect(r.started).toEqual([1]);
  });

  it("queues finals in order behind a running final", async () => {
    const r = controllable();
    const done: number[] = [];
    const s = new MtScheduler(r.run, (e) => e.type === "done" && done.push(e.id));
    s.submit(job(1, false));
    s.submit(job(2, false));
    s.submit(job(3, false));
    r.finish(1, "a");
    await tick();
    r.finish(2, "b");
    await tick();
    r.finish(3, "c");
    await tick();
    expect(done).toEqual([1, 2, 3]);
  });

  it("cancels a running job or a waiting one", async () => {
    const r = controllable();
    const events: { type: string; id: number }[] = [];
    const s = new MtScheduler(r.run, (e) => events.push(e));
    s.submit(job(1, false));
    s.submit(job(2, false));
    s.cancel(2);
    s.cancel(1);
    await tick();
    expect(events).toEqual([
      { type: "cancelled", id: 2 },
      { type: "cancelled", id: 1 },
    ]);
    expect(r.started).toEqual([1]);
  });

  it("reports a failure and moves on", async () => {
    const events: { type: string; id: number }[] = [];
    let calls = 0;
    const s = new MtScheduler(
      async () => {
        if (++calls === 1) throw new Error("boom");
        return result("ok");
      },
      (e) => events.push(e),
    );
    s.submit(job(1, false));
    s.submit(job(2, false));
    await tick();
    await tick();
    expect(events).toEqual([
      { type: "failed", id: 1, message: "boom" },
      { type: "done", id: 2, result: result("ok") },
    ]);
  });
});

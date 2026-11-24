import { describe, expect, it } from "vitest";
import { GpuQueue, type GpuPriority } from "./gpuQueue";
import { deferred, settle, type Deferred } from "./testing";

/** A job that records when it starts and ends when the test says so. */
function recorder(queue: GpuQueue) {
  const order: string[] = [];
  const gates = new Map<string, Deferred<void>>();
  const aborted: string[] = [];
  const submit = (priority: GpuPriority, name: string) => {
    const gate = deferred<void>();
    gates.set(name, gate);
    return queue.submit(priority, async (signal) => {
      order.push(`start ${name}`);
      signal.addEventListener("abort", () => {
        aborted.push(name);
        gate.resolve();
      });
      await gate.promise;
      order.push(`end ${name}`);
      return name;
    });
  };
  const release = async (name: string): Promise<void> => {
    gates.get(name)?.resolve();
    await settle();
  };
  return { order, aborted, submit, release };
}

describe("the GPU queue", () => {
  it("runs one job at a time", async () => {
    const q = new GpuQueue();
    const r = recorder(q);
    r.submit("asr", "a");
    r.submit("asr", "b");
    await settle();
    expect(r.order).toEqual(["start a"]);
    await r.release("a");
    expect(r.order).toEqual(["start a", "end a", "start b"]);
  });

  it("serves a waiting final before a waiting ASR, and ASR before nothing else", async () => {
    const q = new GpuQueue();
    const r = recorder(q);
    r.submit("asr", "running");
    r.submit("asr", "asr-waits");
    r.submit("mt-final", "final-waits");
    await r.release("running");
    expect(r.order).toEqual(["start running", "end running", "start final-waits"]);
    await r.release("final-waits");
    expect(r.order.slice(-2)).toEqual(["end final-waits", "start asr-waits"]);
  });

  it("keeps submission order within one priority", async () => {
    const q = new GpuQueue();
    const r = recorder(q);
    r.submit("mt-final", "first");
    r.submit("mt-final", "second");
    r.submit("mt-final", "third");
    await r.release("first");
    await r.release("second");
    expect(r.order.filter((s) => s.startsWith("start"))).toEqual(["start first", "start second", "start third"]);
  });

  it("never preempts an ASR decode or a final translation that is already running", async () => {
    const q = new GpuQueue();
    const r = recorder(q);
    r.submit("asr", "decode");
    r.submit("mt-final", "final");
    await settle();
    expect(r.aborted).toEqual([]);
    expect(q.snapshot()).toEqual({ running: "asr", waiting: ["mt-final"] });
  });

  it("runs a preview only on an idle GPU", async () => {
    const q = new GpuQueue();
    const r = recorder(q);
    const preview = r.submit("mt-preview", "preview");
    await settle();
    expect(r.order).toEqual(["start preview"]);
    await r.release("preview");
    expect(await preview.outcome).toEqual({ kind: "done", value: "preview" });
  });

  it("skips a preview offered while a job runs or waits, without queueing it", async () => {
    const q = new GpuQueue();
    const r = recorder(q);
    r.submit("asr", "decode");
    const skipped = r.submit("mt-preview", "skipped");
    expect(await skipped.outcome).toEqual({ kind: "skipped" });
    expect(r.order).toEqual(["start decode"]);
    await r.release("decode");
    expect(r.order).toEqual(["start decode", "end decode"]);
  });

  it("aborts a running preview when a final arrives and starts the final once the preview has stopped", async () => {
    const q = new GpuQueue();
    const r = recorder(q);
    const preview = r.submit("mt-preview", "preview");
    await settle();
    const final = r.submit("mt-final", "final");
    await settle();
    expect(r.aborted).toEqual(["preview"]);
    expect(await preview.outcome).toEqual({ kind: "cancelled" });
    expect(r.order.indexOf("start final")).toBeGreaterThan(r.order.indexOf("end preview"));
    await r.release("final");
    expect(await final.outcome).toEqual({ kind: "done", value: "final" });
  });

  it("aborts a running preview when ASR arrives", async () => {
    const q = new GpuQueue();
    const r = recorder(q);
    r.submit("mt-preview", "preview");
    await settle();
    r.submit("asr", "decode");
    await settle();
    expect(r.aborted).toEqual(["preview"]);
    expect(r.order).toContain("start decode");
  });

  it("cancels a waiting job without ever running it", async () => {
    const q = new GpuQueue();
    const r = recorder(q);
    r.submit("asr", "running");
    const waiting = r.submit("asr", "waiting");
    waiting.cancel();
    expect(await waiting.outcome).toEqual({ kind: "cancelled" });
    await r.release("running");
    expect(r.order).not.toContain("start waiting");
  });

  it("reports a job that threw before returning a promise, and keeps serving the next one", async () => {
    const q = new GpuQueue();
    const failing = q.submit("asr", () => {
      throw new Error("device lost");
    });
    const next = q.submit("asr", async () => "next");
    await expect(failing.outcome).rejects.toThrow("device lost");
    expect(await next.outcome).toEqual({ kind: "done", value: "next" });
  });

  it("reports a job that threw, and keeps serving the next one", async () => {
    const q = new GpuQueue();
    const failing = q.submit("asr", () => Promise.reject(new Error("device lost")));
    const next = q.submit("asr", async () => "next");
    await expect(failing.outcome).rejects.toThrow("device lost");
    expect(await next.outcome).toEqual({ kind: "done", value: "next" });
  });
});

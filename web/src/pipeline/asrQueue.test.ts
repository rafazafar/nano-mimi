import { describe, expect, it } from "vitest";
import { AsrQueue, coalesceItems } from "./asrQueue";
import { FakeClock, item, settle } from "./testing";
import { LIVE_OPTIONS, REPLAY_OPTIONS, type PipelineOptions } from "./types";

const live = (keep: number): PipelineOptions => ({ ...LIVE_OPTIONS, queue: { kind: "live", keep } });

describe("coalescing utterances", () => {
  it("concatenates the audio and keeps the oldest enqueue time, the newest audio end and the longest VAD wait", () => {
    const merged = coalesceItems([
      item(10, { enqueuedAtMs: 1000, audioEndS: 1, vadWaitS: 0.1 }),
      item(10, { enqueuedAtMs: 2000, audioEndS: 2, vadWaitS: 0.5 }),
      item(10, { enqueuedAtMs: 3000, audioEndS: 3, vadWaitS: 0.2 }),
    ]);
    expect(merged).toMatchObject({ enqueuedAtMs: 1000, audioEndS: 3, vadWaitS: 0.5 });
    expect(merged?.samples).toHaveLength(30);
  });

  it("keeps the order of the audio", () => {
    const merged = coalesceItems([item(2, { tag: 1 }), item(2, { tag: 2 }), item(2, { tag: 3 })]);
    expect([...(merged?.samples ?? [])]).toEqual([1, 0, 2, 0, 3, 0]);
  });

  it("returns null when none of the items has audio", () => {
    expect(coalesceItems([item(0), item(0)])).toBeNull();
  });
});

describe("the live ASR queue", () => {
  it("merges a backlog into one decode instead of dropping speech", async () => {
    const q = new AsrQueue(LIVE_OPTIONS, new FakeClock());
    await q.enqueue(item(10, { enqueuedAtMs: 1, audioEndS: 1 }));
    expect(q.depth).toBe(1);
    await q.enqueue(item(10, { enqueuedAtMs: 2, audioEndS: 2 }));
    await q.enqueue(item(10, { enqueuedAtMs: 3, audioEndS: 3 }));

    expect(q.depth).toBe(1);
    const only = await q.take();
    expect(only?.samples).toHaveLength(30);
    expect(only?.enqueuedAtMs).toBe(1);
    expect(only?.audioEndS).toBe(3);
  });

  it("with keep=2 holds two items and merges all three when the third arrives", async () => {
    const q = new AsrQueue(live(2), new FakeClock());
    await q.enqueue(item(4, { enqueuedAtMs: 1, audioEndS: 1 }));
    await q.enqueue(item(4, { enqueuedAtMs: 2, audioEndS: 2 }));
    expect(q.depth).toBe(2);
    await q.enqueue(item(4, { enqueuedAtMs: 3, audioEndS: 3 }));
    expect(q.depth).toBe(1);
    const merged = await q.take();
    expect(merged).toMatchObject({ enqueuedAtMs: 1, audioEndS: 3 });
    expect(merged?.samples).toHaveLength(12);
  });

  it("merges an item that already waited past the stale limit with the audio behind it", async () => {
    const clock = new FakeClock();
    const q = new AsrQueue(live(4), clock);
    clock.advance(10_000);
    await q.enqueue(item(100, { enqueuedAtMs: clock.nowMs() - 1400 }));
    await q.enqueue(item(200, { enqueuedAtMs: clock.nowMs() }));
    expect((await q.take())?.samples).toHaveLength(300);
    expect(q.depth).toBe(0);
  });

  it("merges several stale items into one ordered decode", async () => {
    const clock = new FakeClock();
    const q = new AsrQueue(live(4), clock);
    clock.advance(10_000);
    await q.enqueue(item(10, { enqueuedAtMs: clock.nowMs() - 1400 }));
    await q.enqueue(item(20, { enqueuedAtMs: clock.nowMs() - 1400 }));
    await q.enqueue(item(30, { enqueuedAtMs: clock.nowMs() }));
    expect((await q.take())?.samples).toHaveLength(60);
  });

  it("decodes a stale item alone when nothing waits behind it", async () => {
    const clock = new FakeClock();
    const q = new AsrQueue(live(4), clock);
    clock.advance(10_000);
    await q.enqueue(item(50, { enqueuedAtMs: clock.nowMs() - 2000 }));
    q.close();
    expect((await q.take())?.samples).toHaveLength(50);
    expect(await q.take()).toBeNull();
  });

  it("leaves a fresh item alone even with audio behind it", async () => {
    const clock = new FakeClock();
    const q = new AsrQueue(live(4), clock);
    await q.enqueue(item(10, { enqueuedAtMs: clock.nowMs() }));
    await q.enqueue(item(20, { enqueuedAtMs: clock.nowMs() }));
    expect((await q.take())?.samples).toHaveLength(10);
    expect((await q.take())?.samples).toHaveLength(20);
  });

  it("hands an item straight to a waiting taker", async () => {
    const q = new AsrQueue(LIVE_OPTIONS, new FakeClock());
    const taken = q.take();
    await q.enqueue(item(5));
    expect((await taken)?.samples).toHaveLength(5);
    expect(q.depth).toBe(0);
  });

  it("delivers what is queued after close, then null", async () => {
    const q = new AsrQueue(LIVE_OPTIONS, new FakeClock());
    await q.enqueue(item(100));
    q.close();
    expect((await q.take())?.samples).toHaveLength(100);
    expect(await q.take()).toBeNull();
  });

  it("wakes a taker waiting on an empty queue when it closes", async () => {
    const q = new AsrQueue(LIVE_OPTIONS, new FakeClock());
    const taken = q.take();
    q.close();
    expect(await taken).toBeNull();
  });

  it("ignores items enqueued after close", async () => {
    const q = new AsrQueue(LIVE_OPTIONS, new FakeClock());
    q.close();
    await q.enqueue(item(5));
    expect(await q.take()).toBeNull();
  });
});

describe("the replay ASR queue", () => {
  it("never merges or drops: every utterance is decoded, in order, however stale", async () => {
    const clock = new FakeClock();
    const q = new AsrQueue(REPLAY_OPTIONS, clock);
    clock.advance(10_000);
    for (const n of [10, 20, 30]) await q.enqueue(item(n, { enqueuedAtMs: 0 }));
    expect([(await q.take())?.samples.length, (await q.take())?.samples.length, (await q.take())?.samples.length]).toEqual([10, 20, 30]);
  });

  it("makes the producer wait while the queue is full and lets it through when a slot frees", async () => {
    const q = new AsrQueue({ ...REPLAY_OPTIONS, queue: { kind: "lossless", capacity: 1 } }, new FakeClock());
    await q.enqueue(item(4, { enqueuedAtMs: 1 }));
    let queuedSecond = false;
    const second = q.enqueue(item(4, { enqueuedAtMs: 2 })).then(() => (queuedSecond = true));
    await settle();
    expect(queuedSecond).toBe(false);

    expect((await q.take())?.enqueuedAtMs).toBe(1);
    await second;
    expect((await q.take())?.enqueuedAtMs).toBe(2);
  });

  it("releases a waiting producer when it closes, without queueing the item", async () => {
    const q = new AsrQueue({ ...REPLAY_OPTIONS, queue: { kind: "lossless", capacity: 1 } }, new FakeClock());
    await q.enqueue(item(4));
    const blocked = q.enqueue(item(4));
    q.close();
    await blocked;
    expect(q.depth).toBe(1);
  });
});

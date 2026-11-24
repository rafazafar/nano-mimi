import { describe, expect, it, vi } from "vitest";
import { createFrameScheduler, type FrameHost } from "./schedule";

/** A window whose frames and timers run only when the test says so. */
function fakeHost(): FrameHost & { frames: Map<number, () => void>; timers: Map<number, () => void>; fireFrame(): void; fireTimer(): void } {
  let next = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  return {
    frames,
    timers,
    requestAnimationFrame: (cb) => {
      frames.set(next, cb);
      return next++;
    },
    cancelAnimationFrame: (id) => void frames.delete(id),
    setTimeout: (cb) => {
      timers.set(next, cb);
      return next++;
    },
    clearTimeout: (id) => void timers.delete(id),
    fireFrame() {
      const [id, cb] = [...frames][0] ?? [];
      if (id !== undefined && cb !== undefined) {
        frames.delete(id);
        cb();
      }
    },
    fireTimer() {
      const [id, cb] = [...timers][0] ?? [];
      if (id !== undefined && cb !== undefined) {
        timers.delete(id);
        cb();
      }
    },
  };
}

describe("createFrameScheduler", () => {
  it("renders once for a burst of requests", () => {
    const host = fakeHost();
    const render = vi.fn();
    const scheduler = createFrameScheduler(host, render);
    for (let i = 0; i < 50; i++) scheduler.schedule();
    expect(host.frames.size).toBe(1);
    expect(render).not.toHaveBeenCalled();
    host.fireFrame();
    expect(render).toHaveBeenCalledOnce();
  });

  it("accepts a new request after a render", () => {
    const host = fakeHost();
    const render = vi.fn();
    const scheduler = createFrameScheduler(host, render);
    scheduler.schedule();
    host.fireFrame();
    scheduler.schedule();
    host.fireFrame();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("uses no timer unless asked, so a hidden page waits for its next frame", () => {
    const host = fakeHost();
    createFrameScheduler(host, () => undefined).schedule();
    expect(host.timers.size).toBe(0);
  });

  it("renders from the timer when a background tab never delivers a frame", () => {
    const host = fakeHost();
    const render = vi.fn();
    const scheduler = createFrameScheduler(host, render, 100);
    scheduler.schedule();
    host.fireTimer();
    expect(render).toHaveBeenCalledOnce();
    expect(host.frames.size).toBe(0);
  });

  it("drops the timer when the frame wins, and renders once", () => {
    const host = fakeHost();
    const render = vi.fn();
    const scheduler = createFrameScheduler(host, render, 100);
    scheduler.schedule();
    host.fireFrame();
    expect(host.timers.size).toBe(0);
    expect(render).toHaveBeenCalledOnce();
  });

  it("cancels a pending render", () => {
    const host = fakeHost();
    const render = vi.fn();
    const scheduler = createFrameScheduler(host, render, 100);
    scheduler.schedule();
    scheduler.cancel();
    host.fireFrame();
    host.fireTimer();
    expect(render).not.toHaveBeenCalled();
  });
});

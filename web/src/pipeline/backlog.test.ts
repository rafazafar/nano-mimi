import { describe, expect, it } from "vitest";
import { BacklogMonitor, backlogSeconds, nextHealth } from "./backlog";

describe("backlog health", () => {
  it("turns behind at 4 s and clears only below 2 s", () => {
    expect(nextHealth("ok", 3.9)).toBe("ok");
    expect(nextHealth("ok", 4)).toBe("behind");
    expect(nextHealth("behind", 3)).toBe("behind");
    expect(nextHealth("behind", 2)).toBe("behind");
    expect(nextHealth("behind", 1.9)).toBe("ok");
  });

  it("turns overloaded at 10 s and clears below 6 s, into behind while still over 2 s", () => {
    expect(nextHealth("behind", 10)).toBe("overloaded");
    expect(nextHealth("ok", 12)).toBe("overloaded");
    expect(nextHealth("overloaded", 7)).toBe("overloaded");
    expect(nextHealth("overloaded", 5.9)).toBe("behind");
    expect(nextHealth("overloaded", 1)).toBe("ok");
  });

  it("does not flicker when the figure hovers around a threshold", () => {
    let health = nextHealth("ok", 4.1);
    const seen = [3.9, 4.1, 3.5, 4.2, 2.5].map((s) => (health = nextHealth(health, s)));
    expect(new Set(seen)).toEqual(new Set(["behind"]));
  });
});

describe("how far behind speech is", () => {
  it("counts from the end of the oldest speech not yet on screen", () => {
    expect(backlogSeconds(10, [3, 7, 9])).toBe(7);
  });

  it("is zero with nothing unfinished, and never negative", () => {
    expect(backlogSeconds(10, [])).toBe(0);
    expect(backlogSeconds(2, [5])).toBe(0);
  });
});

describe("the backlog monitor", () => {
  it("stays quiet while nothing is behind", () => {
    const m = new BacklogMonitor();
    expect(m.sample(5, [])).toBeNull();
    expect(m.sample(6, [])).toBeNull();
  });

  it("reports the first figure and each change of health", () => {
    const m = new BacklogMonitor();
    expect(m.sample(5, [4])).toEqual({ kind: "backlog", backlogS: 1, health: "ok" });
    expect(m.sample(9, [4])).toEqual({ kind: "backlog", backlogS: 5, health: "behind" });
    expect(m.sample(15, [4])).toEqual({ kind: "backlog", backlogS: 11, health: "overloaded" });
  });

  it("holds back a move smaller than a quarter second inside one health state", () => {
    const m = new BacklogMonitor();
    m.sample(6, [1]);
    expect(m.sample(6.1, [1])).toBeNull();
    expect(m.sample(6.3, [1])).toMatchObject({ backlogS: 5.3 });
  });

  it("reports the clear, down to zero", () => {
    const m = new BacklogMonitor();
    m.sample(9, [4]);
    expect(m.sample(9, [])).toEqual({ kind: "backlog", backlogS: 0, health: "ok" });
    expect(m.sample(10, [])).toBeNull();
  });
});

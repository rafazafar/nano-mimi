import { describe, expect, it } from "vitest";
import { formatBehind, formatMs, formatSeconds, formatTimestamp, percentile } from "./format";

describe("formatTimestamp", () => {
  it("prints mm:ss and floors fractions", () => {
    expect(formatTimestamp(0)).toBe("00:00");
    expect(formatTimestamp(7.9)).toBe("00:07");
    expect(formatTimestamp(67)).toBe("01:07");
    expect(formatTimestamp(3599.99)).toBe("59:59");
  });

  it("adds hours from one hour on", () => {
    expect(formatTimestamp(3600)).toBe("1:00:00");
    expect(formatTimestamp(3 * 3600 + 25 * 60 + 9)).toBe("3:25:09");
  });

  it("reads unusable input as zero", () => {
    expect(formatTimestamp(-4)).toBe("00:00");
    expect(formatTimestamp(Number.NaN)).toBe("00:00");
    expect(formatTimestamp(Number.POSITIVE_INFINITY)).toBe("00:00");
  });
});

describe("durations", () => {
  it("keeps precision proportional to size", () => {
    expect(formatSeconds(0.314)).toBe("0.31 s");
    expect(formatSeconds(4.2)).toBe("4.20 s");
    expect(formatSeconds(38.04)).toBe("38.0 s");
    expect(formatSeconds(412.6)).toBe("413 s");
    expect(formatSeconds(Number.NaN)).toBe("-");
  });

  it("keeps sub-second load times in milliseconds", () => {
    expect(formatMs(820.4)).toBe("820 ms");
    expect(formatMs(14_230)).toBe("14.2 s");
  });
});

describe("formatBehind", () => {
  it("rounds to whole seconds and tells behind from overloaded", () => {
    expect(formatBehind(5.4, "behind")).toBe("Behind by 5 s");
    expect(formatBehind(11.6, "overloaded")).toBe("Overloaded, 12 s behind");
  });
});

describe("percentile", () => {
  it("is null without data", () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it("matches numpy's linear interpolation", () => {
    const xs = [4, 1, 3, 2];
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 0.5)).toBe(2.5);
    expect(percentile(xs, 1)).toBe(4);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBeCloseTo(9.55, 10);
  });

  it("does not reorder the caller's array and clamps p", () => {
    const xs = [3, 1, 2];
    expect(percentile(xs, 2)).toBe(3);
    expect(percentile(xs, -1)).toBe(1);
    expect(xs).toEqual([3, 1, 2]);
  });

  it("handles one value", () => {
    expect(percentile([0.8], 0.95)).toBe(0.8);
  });
});

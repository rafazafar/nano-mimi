import type { CaptionRow } from "../pipeline";
import { percentile } from "./format";

export interface PerceivedStats {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
}

/**
 * Perceived latency (speech end to English on screen) over the rows that are settled right now. A revised
 * row counts once, with its latest timing, so the numbers describe what the viewer was left with.
 */
export function perceivedStats(rows: readonly CaptionRow[]): PerceivedStats | null {
  const values: number[] = [];
  for (const row of rows) if (row.status === "settled" && row.timing !== null) values.push(row.timing.perceivedS);
  const p50 = percentile(values, 0.5);
  const p95 = percentile(values, 0.95);
  return p50 === null || p95 === null ? null : { count: values.length, p50, p95 };
}

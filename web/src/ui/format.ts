const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `mm:ss` on the session timeline, `h:mm:ss` from one hour on. Anything unusable reads as zero. */
export function formatTimestamp(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/** A duration in seconds with the precision that matters at its size: `0.31 s`, `4.20 s`, `38.0 s`. */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "-";
  const s = Math.max(0, seconds);
  return `${s < 10 ? s.toFixed(2) : s < 100 ? s.toFixed(1) : Math.round(s)} s`;
}

/** Engine load times arrive in milliseconds; sub-second ones stay in ms. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  return ms < 1000 ? `${Math.round(ms)} ms` : formatSeconds(ms / 1000);
}

/** Whole seconds for the header indicator, where a decimal would only flicker. */
export function formatBehind(backlogS: number, health: "behind" | "overloaded"): string {
  const s = Math.max(0, Math.round(backlogS));
  return health === "overloaded" ? `Overloaded, ${s} s behind` : `Behind by ${s} s`;
}

/** A percentile of `values` by linear interpolation between ranks (numpy's default). Null when there is no data. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (rank - lo);
}

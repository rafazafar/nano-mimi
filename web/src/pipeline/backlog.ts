import type { Health, PipelineEvent } from "./types";

/** Port of `HEALTH_*` in config.py. Each state clears below its own, lower threshold so the indicator does not flicker. */
export const BEHIND_S = 4;
export const BEHIND_CLEAR_S = 2;
export const OVERLOADED_S = 10;
export const OVERLOADED_CLEAR_S = 6;

/** Port of `latency_health.next_state`. */
export function nextHealth(prev: Health, backlogS: number): Health {
  let from = prev;
  if (from === "overloaded") {
    if (backlogS >= OVERLOADED_CLEAR_S) return "overloaded";
    from = "behind";
  }
  if (backlogS >= OVERLOADED_S) return "overloaded";
  if (from === "behind") return backlogS >= BEHIND_CLEAR_S ? "behind" : "ok";
  return backlogS >= BEHIND_S ? "behind" : "ok";
}

/**
 * How long ago, on the audio clock, the oldest speech not yet on screen ended. An utterance that is merely
 * being processed counts only from its end, so a long one is not "behind" while it is spoken.
 */
export function backlogSeconds(audioNowS: number, unfinishedEndsS: readonly number[]): number {
  return unfinishedEndsS.length === 0 ? 0 : Math.max(0, audioNowS - Math.min(...unfinishedEndsS));
}

/** Turns samples of the backlog into `backlog` events: only when the health changes or the figure moves by a quarter second. */
export class BacklogMonitor {
  #health: Health = "ok";
  #lastBacklogS = 0;

  sample(audioNowS: number, unfinishedEndsS: readonly number[]): PipelineEvent | null {
    const backlogS = backlogSeconds(audioNowS, unfinishedEndsS);
    const health = nextHealth(this.#health, backlogS);
    const moved = Math.abs(backlogS - this.#lastBacklogS) >= 0.25;
    const cleared = backlogS === 0 && this.#lastBacklogS !== 0;
    if (health === this.#health && !moved && !cleared) return null;
    this.#health = health;
    this.#lastBacklogS = backlogS;
    return { kind: "backlog", backlogS, health };
  }
}

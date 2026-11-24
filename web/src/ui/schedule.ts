/** The timing functions of a window; the app's window and the floating one both satisfy it. */
export interface FrameHost {
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(id: number): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface FrameScheduler {
  /** Asks for one render. Any number of calls before it runs make one render. */
  schedule(): void;
  /** Cancels a pending render. */
  cancel(): void;
}

/**
 * Coalesces render requests into one per frame, so a burst of token events costs one DOM pass.
 *
 * A background tab gets no animation frames, which would freeze the floating captions exactly when they
 * matter, so `fallbackMs` also arms a timer and whichever fires first renders. The main page omits it:
 * nothing is visible there while it is hidden, and it catches up on the next frame.
 */
export function createFrameScheduler(host: FrameHost, render: () => void, fallbackMs?: number): FrameScheduler {
  let frame: number | null = null;
  let timer: number | null = null;
  const cancel = (): void => {
    if (frame !== null) host.cancelAnimationFrame(frame);
    if (timer !== null) host.clearTimeout(timer);
    frame = null;
    timer = null;
  };
  const run = (): void => {
    cancel();
    render();
  };
  return {
    schedule() {
      if (frame !== null) return;
      frame = host.requestAnimationFrame(run);
      if (fallbackMs !== undefined) timer = host.setTimeout(run, fallbackMs);
    },
    cancel,
  };
}

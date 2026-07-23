export interface TrailingThrottle {
  /** Ask for a run. Coalesces bursts: at most one run per interval, trailing. */
  schedule(): void;
  /** Mark an out-of-band run so the next schedule() waits a full interval. */
  touch(): void;
  dispose(): void;
}

/**
 * Trailing throttle for expensive broadcasts. `schedule()` runs `fn` as soon
 * as a full interval has passed since the previous run (immediately when the
 * line is quiet), and coalesces every call made in between into that one run.
 */
export function createTrailingThrottle(fn: () => void, intervalMs: number): TrailingThrottle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRunAt = Number.NEGATIVE_INFINITY;

  return {
    schedule() {
      if (timer !== null) {
        return;
      }

      const wait = Math.max(0, intervalMs - (Date.now() - lastRunAt));

      timer = setTimeout(() => {
        timer = null;
        lastRunAt = Date.now();
        fn();
      }, wait);
    },

    touch() {
      lastRunAt = Date.now();
    },

    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

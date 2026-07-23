import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrailingThrottle } from "../../lib/effector/throttle";

describe("createTrailingThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst into a single run", () => {
    const fn = vi.fn();
    const throttle = createTrailingThrottle(fn, 1000);

    throttle.schedule();
    throttle.schedule();
    throttle.schedule();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs immediately when the line has been quiet for a full interval", () => {
    const fn = vi.fn();
    const throttle = createTrailingThrottle(fn, 1000);

    throttle.schedule();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    throttle.schedule();
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("waits out the remainder of the interval after a recent run", () => {
    const fn = vi.fn();
    const throttle = createTrailingThrottle(fn, 1000);

    throttle.schedule();
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(400);
    throttle.schedule();
    vi.advanceTimersByTime(599);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("counts out-of-band runs marked with touch()", () => {
    const fn = vi.fn();
    const throttle = createTrailingThrottle(fn, 1000);

    vi.advanceTimersByTime(5000);
    throttle.touch();
    throttle.schedule();
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels the pending run", () => {
    const fn = vi.fn();
    const throttle = createTrailingThrottle(fn, 1000);

    throttle.schedule();
    throttle.dispose();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});

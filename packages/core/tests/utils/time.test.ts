import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { event, owner, reaction, scope, scoped, store } from "../../lib";
import { debounce, delay, interval, throttle } from "../../lib/utils";
import { readValue } from "../support/store-helpers";

describe("time operators", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("debounce", () => {
    it("fires once with the last payload after a quiet window", () => {
      const s = scope();
      const src = event<number>("search");
      const out = debounce(src, 300);
      const seen: number[] = [];

      reaction({ on: out, run: (v: number) => seen.push(v) });

      scoped(s, () => void src(1));
      vi.advanceTimersByTime(100);
      scoped(s, () => void src(2));
      vi.advanceTimersByTime(299);
      expect(seen).toEqual([]);

      vi.advanceTimersByTime(1);
      expect(seen).toEqual([2]);
    });

    it("keeps scopes independent", () => {
      const a = scope();
      const b = scope();
      const src = event<string>();
      const out = debounce(src, 100);
      const seen: string[] = [];

      reaction({ on: out, run: (v: string) => seen.push(v) });

      scoped(a, () => void src("a"));
      vi.advanceTimersByTime(60);
      // b's hit must not reset a's window.
      scoped(b, () => void src("b"));
      vi.advanceTimersByTime(40);
      expect(seen).toEqual(["a"]);

      vi.advanceTimersByTime(60);
      expect(seen).toEqual(["a", "b"]);
    });

    it("leading: fires the first hit immediately, then stays silent until a pause", () => {
      const s = scope();
      const src = event<number>();
      const out = debounce(src, { ms: 100, leading: true });
      const seen: number[] = [];

      reaction({ on: out, run: (v: number) => seen.push(v) });

      scoped(s, () => void src(1));
      expect(seen).toEqual([1]);

      vi.advanceTimersByTime(50);
      scoped(s, () => void src(2));
      vi.advanceTimersByTime(99);
      scoped(s, () => void src(3));
      expect(seen).toEqual([1]);

      // A full quiet window re-arms the leading edge.
      vi.advanceTimersByTime(100);
      scoped(s, () => void src(4));
      expect(seen).toEqual([1, 4]);
    });

    it("store source: derived store starts at the source initial and settles per scope", () => {
      const a = scope();
      const b = scope();
      const $q = store("init");
      const $d = debounce($q, 300);

      expect(readValue(a, $d)).toBe("init");

      scoped(a, () => {
        $q.value = "typed";
      });
      vi.advanceTimersByTime(299);
      expect(readValue(a, $d)).toBe("init");

      vi.advanceTimersByTime(1);
      expect(readValue(a, $d)).toBe("typed");
      expect(readValue(b, $d)).toBe("init");
    });

    it("owner dispose cancels the pending window", () => {
      const s = scope();
      const src = event<number>();
      const seen: number[] = [];
      const app = owner((dispose) => {
        const out = debounce(src, 100);

        reaction({ on: out, run: (v: number) => seen.push(v) });

        return { dispose };
      });

      scoped(s, () => void src(1));
      app.dispose();
      vi.advanceTimersByTime(200);
      expect(seen).toEqual([]);
    });
  });

  describe("throttle", () => {
    it("trailing by default: the window's last value fires at the window end", () => {
      const s = scope();
      const src = event<number>();
      const out = throttle(src, 100);
      const seen: number[] = [];

      reaction({ on: out, run: (v: number) => seen.push(v) });

      scoped(s, () => void src(1));
      vi.advanceTimersByTime(10);
      scoped(s, () => void src(2));
      vi.advanceTimersByTime(10);
      scoped(s, () => void src(3));
      expect(seen).toEqual([]);

      vi.advanceTimersByTime(80);
      expect(seen).toEqual([3]);
    });

    it("leading: fires immediately and still fires the trailing hit", () => {
      const s = scope();
      const src = event<number>();
      const out = throttle(src, { ms: 100, leading: true });
      const seen: number[] = [];

      reaction({ on: out, run: (v: number) => seen.push(v) });

      scoped(s, () => void src(1));
      expect(seen).toEqual([1]);

      vi.advanceTimersByTime(10);
      scoped(s, () => void src(2));
      vi.advanceTimersByTime(90);
      expect(seen).toEqual([1, 2]);
    });

    it("a trailing emission opens a cooldown window of its own", () => {
      const s = scope();
      const src = event<number>();
      const out = throttle(src, 100);
      const seen: number[] = [];

      reaction({ on: out, run: (v: number) => seen.push(v) });

      scoped(s, () => void src(1));
      vi.advanceTimersByTime(100);
      expect(seen).toEqual([1]);

      // Right after the trailing fire — lands in the cooldown, not immediately.
      scoped(s, () => void src(2));
      vi.advanceTimersByTime(99);
      expect(seen).toEqual([1]);
      vi.advanceTimersByTime(1);
      expect(seen).toEqual([1, 2]);
    });
  });

  describe("delay", () => {
    it("shifts every hit independently, preserving order", () => {
      const s = scope();
      const src = event<number>();
      const out = delay(src, 100);
      const seen: number[] = [];

      reaction({ on: out, run: (v: number) => seen.push(v) });

      scoped(s, () => void src(1));
      vi.advanceTimersByTime(50);
      scoped(s, () => void src(2));
      vi.advanceTimersByTime(50);
      expect(seen).toEqual([1]);

      vi.advanceTimersByTime(50);
      expect(seen).toEqual([1, 2]);
    });
  });

  describe("interval", () => {
    it("ticks between start and stop, per scope, with a reactive active flag", () => {
      const s = scope();
      const other = scope();
      const start = event<void>();
      const stop = event<void>();
      const { tick, active } = interval({ ms: 100, start, stop });
      let ticks = 0;

      reaction({ on: tick, run: () => (ticks += 1) });

      scoped(s, () => void start());
      expect(readValue(s, active)).toBe(true);
      expect(readValue(other, active)).toBe(false);

      vi.advanceTimersByTime(350);
      expect(ticks).toBe(3);

      scoped(s, () => void stop());
      expect(readValue(s, active)).toBe(false);

      vi.advanceTimersByTime(300);
      expect(ticks).toBe(3);
    });

    it("leading ticks immediately; start while running is a no-op", () => {
      const s = scope();
      const start = event<void>();
      const { tick } = interval({ ms: 100, start, leading: true });
      let ticks = 0;

      reaction({ on: tick, run: () => (ticks += 1) });

      scoped(s, () => void start());
      expect(ticks).toBe(1);

      vi.advanceTimersByTime(50);
      scoped(s, () => void start());
      vi.advanceTimersByTime(50);
      // A second start neither re-ticked the leading edge nor reset the phase.
      expect(ticks).toBe(2);
    });

    it("owner dispose stops ticking and clears active", () => {
      const s = scope();
      const start = event<void>();
      let ticks = 0;
      const app = owner((dispose) => {
        const handle = interval({ ms: 100, start });

        reaction({ on: handle.tick, run: () => (ticks += 1) });

        return { active: handle.active, dispose };
      });

      scoped(s, () => void start());
      vi.advanceTimersByTime(100);
      expect(ticks).toBe(1);
      expect(readValue(s, app.active)).toBe(true);

      app.dispose();
      expect(readValue(s, app.active)).toBe(false);

      vi.advanceTimersByTime(300);
      expect(ticks).toBe(1);
    });
  });
});

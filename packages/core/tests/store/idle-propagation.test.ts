import { describe, expect, it, vi } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";
import { onInspectorEvent } from "../../lib/kernel/inspector";

describe("unobserved store updates", () => {
  it("commits and notifies subscribers without an empty kernel traversal", () => {
    const app = scope(),
      value = store(0);
    const run = vi.spyOn(value.node, "run");
    const subscriber = vi.fn();
    const unsubscribe = value.subscribe(subscriber);
    scoped(app, () => {
      value.value = 1;
    });
    expect(scoped(app, () => value.value)).toBe(1);
    expect(subscriber).toHaveBeenCalledWith(1, app);
    expect(run).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("notifies an observer attached by a subscriber during the same commit", () => {
    const app = scope(),
      value = store(0);
    const values: number[] = [];
    let observer: ReturnType<typeof reaction> | undefined;
    const unsubscribe = value.subscribe(() => {
      observer ??= reaction({
        on: value,
        scope: app,
        run: (next) => {
          values.push(next);
        },
      });
    });
    scoped(app, () => {
      value.value = 1;
    });
    expect(values).toEqual([1]);
    observer?.stop();
    unsubscribe();
  });

  it("supports late computed activation and keeps inspected writes visible", () => {
    const app = scope(),
      value = store(0);
    scoped(app, () => {
      value.value = 1;
    });
    const doubled = computed(() => value.value * 2);
    const values: number[] = [];
    const observer = reaction({
      scope: app,
      run: () => {
        values.push(doubled.value);
      },
    });
    scoped(app, () => {
      value.value = 2;
    });
    expect(values).toEqual([2, 4]);
    observer.stop();
    const seen: string[] = [];
    const stop = onInspectorEvent((event) => {
      if ("node" in event && event.node === value.node) seen.push(event.type);
    });
    try {
      scoped(app, () => {
        value.value = 3;
      });
      expect(seen).toContain("node-start");
      expect(seen).toContain("node-end");
    } finally {
      stop();
    }
  });
});

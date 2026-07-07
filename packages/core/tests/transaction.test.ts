import { describe, expect, it } from "vitest";
import { event, reaction, reactive, scope, scoped, store } from "../lib";

describe("transactions", () => {
  it("commits several store writes once at the end of a transaction", async () => {
    const appScope = scope();
    const incremented = event();
    const count = store(0);
    const values: number[] = [];

    reaction({
      on: incremented,
      run() {
        count.value++;
        count.value++;
      },
    });
    reaction({
      on: count,
      run(value) {
        values.push(value);
      },
    });

    await scoped(appScope, () => incremented());

    scoped(appScope, () => {
      expect(count.value).toBe(2);
    });
    expect(values).toEqual([2]);
  });

  it("keeps explicit nested unit calls ordered in one transaction draft", async () => {
    const appScope = scope();
    const featureTogglePressed = event();
    const featureEnabled = event();
    const legacyModeDisabled = event();
    const metrics = reactive({ items: [] as string[] });
    const snapshots: string[][] = [];

    reaction({
      on: featureTogglePressed,
      run() {
        void featureEnabled();
        void legacyModeDisabled();
      },
    });
    reaction({
      on: featureEnabled,
      run() {
        metrics.items = [...metrics.items, "feature-enabled"];
      },
    });
    reaction({
      on: legacyModeDisabled,
      run() {
        metrics.items = [...metrics.items, "legacy-mode-disabled"];
      },
    });
    reaction({
      on: metrics,
      run(value) {
        snapshots.push(value.items);
      },
    });

    await scoped(appScope, () => featureTogglePressed());

    scoped(appScope, () => {
      expect(metrics.items).toEqual(["feature-enabled", "legacy-mode-disabled"]);
    });
    expect(snapshots).toEqual([["feature-enabled", "legacy-mode-disabled"]]);
  });
});

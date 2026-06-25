import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store } from "../lib";

describe("computed", () => {
  it("computes lazily and caches value until a dependency changes", () => {
    const appScope = scope();
    const count = store(1);
    let calls = 0;
    const doubled = computed(() => {
      calls += 1;
      return count.value * 2;
    });

    expect(calls).toBe(0);

    scoped(appScope, () => {
      expect(doubled.value).toBe(2);
      expect(doubled.value).toBe(2);
    });
    expect(calls).toBe(1);

    scoped(appScope, () => {
      count.value = 2;
    });
    expect(calls).toBe(1);

    scoped(appScope, () => {
      expect(doubled.value).toBe(4);
    });
    expect(calls).toBe(2);
  });

  it("keeps mapped stores lazy while inactive", () => {
    const appScope = scope();
    const count = store(1);
    let calls = 0;
    const doubled = count.map((value) => {
      calls += 1;
      return value * 2;
    });
    const values: number[] = [];

    scoped(appScope, () => {
      count.value = 2;
    });
    expect(calls).toBe(0);

    scoped(appScope, () => {
      expect(doubled.value).toBe(4);
    });
    expect(calls).toBe(1);

    reaction({
      on: doubled,
      run(value: number) {
        values.push(value);
      },
    });

    scoped(appScope, () => {
      count.value = 3;
    });

    expect(calls).toBe(2);
    expect(values).toEqual([6]);
  });

  it("keeps filtered stores lazy without exposing skip token", () => {
    const appScope = scope();
    const count = store(0);
    const positive = count.filter((value) => value > 0);
    const values: number[] = [];

    reaction({
      on: positive,
      run(value: number) {
        values.push(value);
      },
    });

    scoped(appScope, () => {
      expect(positive.value).toBe(0);
      count.value = -1;
      expect(positive.value).toBe(0);
      count.value = 2;
      expect(positive.value).toBe(2);
    });

    expect(values).toEqual([2]);
  });

  it("keeps computed cache isolated per scope", () => {
    const firstScope = scope();
    const secondScope = scope();
    const count = store(1);
    let calls = 0;
    const doubled = computed(() => {
      calls += 1;
      return count.value * 2;
    });

    scoped(firstScope, () => {
      count.value = 2;
      expect(doubled.value).toBe(4);
    });
    scoped(secondScope, () => {
      count.value = 10;
      expect(doubled.value).toBe(20);
    });
    scoped(firstScope, () => {
      expect(doubled.value).toBe(4);
    });

    expect(calls).toBe(2);
  });

  it("notifies reactions when observed computed value changes", () => {
    const appScope = scope();
    const count = store(1);
    const parity = computed(() => (count.value % 2 === 0 ? "even" : "odd"));
    const values: string[] = [];

    reaction(() => {
      values.push(parity.value);
    });

    scoped(appScope, () => {
      expect(parity.value).toBe("odd");
      count.value = 3;
      count.value = 4;
    });

    expect(values).toEqual(["odd", "even"]);
  });

  it("supports object snapshots", () => {
    const appScope = scope();
    const firstName = store("Ada");
    const lastName = store("Lovelace");
    const user = computed(() => ({
      label: `${firstName.value} ${lastName.value}`,
    }));

    scoped(appScope, () => {
      expect(user.value.label).toBe("Ada Lovelace");
    });
  });
});

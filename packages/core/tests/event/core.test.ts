import { describe, expect, it } from "vitest";
import { event, getCurrentScope, owner, reaction, scope, scoped, store } from "../../lib";
import type { Event } from "../../lib";
import { node, run } from "../../lib/internal";
import { nameUnit } from "../../lib/devtools";
import { flush } from "../support/async-flush";

describe("event", () => {
  it("requires an active scope when called as a function", async () => {
    const submitted = event<number>();

    const callWithoutScope = () => submitted(1);

    expect(callWithoutScope).toThrow("Scope is required");
  });

  it("names the offending event in its scope-less call error", () => {
    const submitted = event<number>("submitted");

    expect(() => submitted(1)).toThrow(/Scope is required to call event "submitted"/);
    expect(() => submitted(1)).toThrow(/scoped/);
  });

  it("reports the unit path that led to a scope-less call inside a handler", async () => {
    const inner = event<number>("inner");
    const caller = node({
      run(ctx) {
        // Runs with no active scope; calling a unit from here must fail and the
        // error should name the chain of units that led to the offending call.
        inner(ctx.value as number);
      },
    });

    nameUnit(caller, "caller");

    await expect(run({ unit: caller, payload: 1 })).rejects.toThrow(
      /Unit path that led here: .*caller.* → .*event "inner"/,
    );
  });

  it("runs explicit reactions when called in a scope", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const values: number[] = [];
    reaction({
      on: submitted,
      run: (value: number) => {
        values.push(value);
      },
    });

    await scoped(appScope, () => submitted(3));

    expect(values).toEqual([3]);
  });

  it("resolves the event-call promise only after its reaction has run", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const seen: number[] = [];

    reaction({ on: submitted, run: (value) => seen.push(value) });

    await scoped(appScope, () => submitted(7));

    // The value is present the instant the await resolves — not a tick later.
    expect(seen).toEqual([7]);
  });

  it("delivers undefined to its reaction when called with no argument", async () => {
    const appScope = scope();
    const ping = event<void>();
    const received: unknown[] = ["sentinel"];

    reaction({ on: ping, run: (value) => received.push(value) });

    await scoped(appScope, () => ping());

    expect(received).toEqual(["sentinel", undefined]);
  });

  it("derives events with map, filter, and filterMap", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const doubled = submitted.map((value) => value * 2);
    const even = submitted.filter((value) => value % 2 === 0);
    const label = submitted.filterMap((value) => (value > 2 ? `#${value}` : undefined));
    const values: unknown[] = [];

    reaction({
      on: doubled,
      run: (value: number) => {
        values.push(["doubled", value]);
      },
    });
    reaction({
      on: even,
      run: (value: number) => {
        values.push(["even", value]);
      },
    });
    reaction({
      on: label,
      run: (value: string) => {
        values.push(["label", value]);
      },
    });

    await scoped(appScope, () => submitted(2));
    await scoped(appScope, () => submitted(3));

    expect(values).toEqual([
      ["doubled", 4],
      ["even", 2],
      ["doubled", 6],
      ["label", "#3"],
    ]);
  });

  it("emits mapped payloads in their original order", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const doubled = submitted.map((value) => value * 2);
    const seen: number[] = [];

    reaction({ on: doubled, run: (value) => seen.push(value) });

    await scoped(appScope, () => submitted(1));
    await scoped(appScope, () => submitted(2));
    await scoped(appScope, () => submitted(3));

    expect(seen).toEqual([2, 4, 6]);
  });

  it("drops payloads that fail its filter predicate", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const even = submitted.filter((value) => value % 2 === 0);
    const seen: number[] = [];

    reaction({ on: even, run: (value) => seen.push(value) });

    await scoped(appScope, () => submitted(3));
    await scoped(appScope, () => submitted(4));
    await scoped(appScope, () => submitted(5));
    await scoped(appScope, () => submitted(6));

    expect(seen).toEqual([4, 6]);
  });

  it("forwards falsy filterMap results but stops only on strict undefined", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const mapped = submitted.filterMap((value) => {
      if (value === 1) return null;
      if (value === 2) return 0;
      if (value === 3) return undefined; // the only stop
      if (value === 4) return "";
      if (value === 5) return false;
      return value;
    });
    const seen: unknown[] = [];

    reaction({ on: mapped, run: (value) => seen.push(value) });

    for (const value of [1, 2, 3, 4, 5, 6]) {
      await scoped(appScope, () => submitted(value));
    }

    // 3 dropped (undefined); every other falsy value forwarded.
    expect(seen).toEqual([null, 0, "", false, 6]);
  });

  it("forwards a NaN filterMap result because NaN is not undefined", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const mapped = submitted.filterMap(() => NaN);
    const seen: number[] = [];

    reaction({ on: mapped, run: (value) => seen.push(value) });

    await scoped(appScope, () => submitted(1));

    expect(seen).toHaveLength(1);
    expect(Number.isNaN(seen[0])).toBe(true);
  });

  it("short-circuits a map-filter-map chain when its filter stops", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const tail = submitted
      .map((value) => value + 1)
      .filter((value) => value > 2)
      .map((value) => value * 10);
    const seen: number[] = [];

    reaction({ on: tail, run: (value) => seen.push(value) });

    await scoped(appScope, () => submitted(1)); // 1->2, not >2, filtered
    await scoped(appScope, () => submitted(5)); // 5->6>2->60

    expect(seen).toEqual([60]);
  });

  it("rejects the event-call promise when a map function throws", async () => {
    const appScope = scope();
    const boom = new Error("map exploded");
    const submitted = event<number>();
    const bad = submitted.map(() => {
      throw boom;
    });

    reaction({ on: bad, run: () => {} });

    await expect(scoped(appScope, () => submitted(1))).rejects.toBe(boom);
  });

  it("splices a derived node out of the source's next list when its owner is disposed", async () => {
    const appScope = scope();
    const submitted = event<number>();
    let mapped!: Event<number>;
    const fired: number[] = [];

    const model = owner(() => {
      mapped = submitted.map((value) => value + 1);
      reaction({ on: mapped, run: (value) => fired.push(value) });
      return {};
    });

    expect((submitted.node.next ?? []).length).toBe(1);

    await scoped(appScope, () => submitted(10));
    expect(fired).toEqual([11]);

    model.dispose();

    // The derived node is gone from the source's next list.
    expect((submitted.node.next ?? []).length).toBe(0);

    await scoped(appScope, () => submitted(20));
    // Reaction never fires again.
    expect(fired).toEqual([11]);
  });

  it("restores the caller's ambient scope after awaiting an event call", async () => {
    const appScope = scope();
    const submitted = event<number>();

    reaction({
      on: submitted,
      // async reaction crosses a microtask
      run: async () => {
        await Promise.resolve();
      },
    });

    const returnedScope = await scoped(appScope, async () => {
      await submitted(1);
      // A subsequent unit call in the same body must not throw "Scope is required".
      await submitted(2);
      return getCurrentScope();
    });

    expect(returnedScope).toBe(appScope);
  });

  it("lands a post-await store write in the caller scope", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const counter = store(0);

    reaction({ on: submitted, run: async () => await Promise.resolve() });

    await scoped(appScope, async () => {
      await submitted(1);
      counter.value = 5;
    });

    expect(scoped(appScope, () => counter.value)).toBe(5);
  });

  it("does not absorb downstream reads into an auto-reaction that calls it", async () => {
    const trackedStore = store(1);
    const downstreamStore = store(2);
    const bump = event<void>();

    // Downstream (explicit) reaction reads downstreamStore.
    reaction({
      on: bump,
      run: () => {
        void scoped(scope(), () => downstreamStore.value);
      },
    });

    // Auto reaction A: reads trackedStore, then calls the event.
    const auto = reaction(() => {
      void trackedStore.value;
      void bump();
    });

    await flush();

    const deps = auto.dependencies();
    expect(deps).toContain(trackedStore.node);
    expect(deps).not.toContain(downstreamStore.node);
  });

  it("still tracks a micro-scope reaction's reads after an awaited event call", async () => {
    const before = store(1);
    const after = store(2);
    const pause = event<void>();
    let afterReadError: unknown = null;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const auto = reaction(async () => {
      void before.value;
      await pause();
      try {
        void after.value;
      } catch (error) {
        afterReadError = error;
      }
      resolveDone();
    });

    await done;
    await flush();

    expect(afterReadError).toBeNull();
    const deps = auto.dependencies();
    expect(deps).toContain(before.node);
    // The post-await read is tracked because the micro-scope ambient was restored.
    expect(deps).toContain(after.node);
  });
});

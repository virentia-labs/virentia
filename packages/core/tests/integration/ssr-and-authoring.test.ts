import { describe, expect, it } from "vitest";
import {
  computed,
  dependency,
  effect,
  reaction,
  scope,
  scoped,
  seedScopeStoreValue,
  store,
} from "../../lib";
import { node, requireActiveScope, run, trackNode, writeTransactionStore } from "../../lib/internal";
import type { StoreCommitResult } from "../../lib/internal";
import { flush } from "../support/async-flush";

describe("SSR round trip", () => {
  it("hydrates derived stores from a serialized snapshot", async () => {
    const $id = store(0);
    const $name = store("");
    const $label = computed(() => `${$name.value}#${$id.value}`);
    const loadFx = effect(async () => ({ id: 7, name: "ann" }));

    const server = scope();
    await scoped(server, async () => {
      const data = await loadFx();
      $id.value = data.id;
      $name.value = data.name;
    });
    await flush(20);

    // What an SSR layer would ship: the plain values, not the units.
    const snapshot = scoped(server, () => ({ id: $id.value, name: $name.value }));

    expect(snapshot).toEqual({ id: 7, name: "ann" });

    const client = scope({
      values: [
        [$id, snapshot.id],
        [$name, snapshot.name],
      ],
    });

    expect(scoped(client, () => $label.value)).toBe("ann#7");
  });

  it("keeps a hydrated scope reactive afterwards", () => {
    const $n = store(0);
    const $doubled = $n.map((v) => v * 2);
    const client = scope({ values: [[$n, 5]] });
    const seen: number[] = [];

    reaction({ on: $doubled, scope: client, run: (v: number) => seen.push(v) });

    expect(scoped(client, () => $doubled.value)).toBe(10);

    scoped(client, () => {
      $n.value = 6;
    });

    expect(seen).toEqual([12]);
  });

  it("seedScopeStoreValue matches constructor seeding", () => {
    const $n = store(1);
    const $d = $n.map((v) => v + 100);
    const viaConstructor = scope({ values: [[$n, 9]] });
    const viaSeed = scope();

    seedScopeStoreValue(viaSeed, $n, 9);

    expect([scoped(viaConstructor, () => $d.value), scoped(viaSeed, () => $d.value)]).toEqual([
      109, 109,
    ]);
  });

  it("dependencies are not part of the value snapshot", () => {
    const api = dependency<{ base: string }>("api");
    const $url = computed(() => `${api.value.base}/x`);
    const server = scope({ deps: [[api, { base: "https://server" }]] });

    expect(scoped(server, () => $url.value)).toBe("https://server/x");

    // A client scope must re-provide the dependency; values alone do not carry it.
    const clientWithout = scope();

    expect(() => scoped(clientWithout, () => $url.value)).toThrow();

    const clientWith = scope({ deps: [[api, { base: "https://client" }]] });

    expect(scoped(clientWith, () => $url.value)).toBe("https://client/x");
  });
});

describe("custom unit authored on @virentia/core/internal", () => {
  // A minimal store built the way @virentia/mutable builds one: its own node,
  // its own scope slot, committed through the transaction layer.
  function customStore(initial: number) {
    const id = Symbol("custom");
    const storeNode = node({
      meta: { type: "custom" },
      run: (ctx) => ctx.value,
    });

    const readValue = (): number => {
      const scopeRef = requireActiveScope(() => "read custom store");

      trackNode(storeNode);

      return (scopeRef.values.get(id) as number | undefined) ?? initial;
    };

    return {
      node: storeNode,
      get value(): number {
        return readValue();
      },
      set(next: number): void {
        const scopeRef = requireActiveScope(() => "write custom store");

        writeTransactionStore(
          {
            id,
            scope: scopeRef,
            commit: (value): StoreCommitResult => {
              const previous = (scopeRef.values.get(id) as number | undefined) ?? initial;

              if (Object.is(previous, value)) {
                return { changed: false, notify: () => {} };
              }

              scopeRef.values.set(id, value);

              return {
                changed: true,
                notify: () => {
                  void run({ unit: storeNode, payload: value, scope: scopeRef });
                },
              };
            },
          },
          next,
        );
      },
    };
  }

  it("drives a computed that observes it", () => {
    const s = scope();
    const custom = customStore(1);
    const $doubled = computed(() => custom.value * 2);
    const seen: number[] = [];

    reaction({ on: $doubled, run: (v: number) => seen.push(v) });

    scoped(s, () => {
      custom.set(5);
    });

    expect(seen).toEqual([10]);
  });

  it("survives a read of the derived partway through its own update", () => {
    const s = scope();
    const custom = customStore(0);
    const $flag = computed(() => custom.value > 0);
    let hits = 0;

    reaction({ on: computed(() => custom.value), run: () => void $flag.value });
    reaction({ on: $flag, run: () => hits++ });

    scoped(s, () => {
      custom.set(3);
    });

    expect(hits).toBe(1);
  });

  it("a unit that BYPASSES the transaction layer still notifies", () => {
    const s = scope();
    const id = Symbol("raw");
    const rawNode = node({ meta: { type: "raw" }, run: (ctx) => ctx.value });
    const read = (): number => {
      const scopeRef = requireActiveScope(() => "read raw store");

      trackNode(rawNode);

      return (scopeRef.values.get(id) as number | undefined) ?? 0;
    };
    const write = (next: number): void => {
      const scopeRef = requireActiveScope(() => "write raw store");

      scopeRef.values.set(id, next);
      void run({ unit: rawNode, payload: next, scope: scopeRef });
    };

    const $flag = computed(() => read() > 0);
    let hits = 0;

    reaction({ on: computed(() => read()), run: () => void $flag.value });
    reaction({ on: $flag, run: () => hits++ });

    scoped(s, () => {
      write(3);
    });

    expect(hits).toBe(1);
  });

  it("keeps per-scope isolation", () => {
    const a = scope();
    const b = scope();
    const custom = customStore(0);
    const $view = computed(() => custom.value * 10);

    scoped(a, () => {
      custom.set(1);
    });
    scoped(b, () => {
      custom.set(2);
    });

    expect([scoped(a, () => $view.value), scoped(b, () => $view.value)]).toEqual([10, 20]);
  });
});

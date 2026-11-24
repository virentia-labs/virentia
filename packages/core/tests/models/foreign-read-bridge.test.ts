import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped, store, type Scope } from "../../lib";
import type { Node } from "../../lib/kernel/types";
import { f, staticModel } from "../../lib/models";

// A computed read in one scope over state that lives in another (a model
// field, a store resolved to a fixed scope) depends on a bridge. When the
// computed is first observed it discovers its dependencies once in a throwaway
// scope; the bridge must not treat that scope as a reader, or every write runs
// the computed and its observers once more.
describe("foreign read bridges", () => {
  it("run an observer of a model field read from the application scope once per write", async () => {
    const Row = staticModel({
      data: { count: f.number(0) },
      setup(self) {
        const increment = event<number>();
        reaction({
          on: increment,
          run: (by) => {
            self.count.value += by;
          },
        });
        return { increment };
      },
    });
    const app = scope();
    const row = scoped(app, () => Row.create({ id: "a", count: 3 }));
    const total = computed(() => row.count.value + 1);
    const seen: number[] = [];
    const evaluated: number[] = [];
    scoped(app, () => reaction({ on: total, run: (value) => seen.push(value) }));
    scoped(app, () =>
      reaction({
        on: computed(() => {
          evaluated.push(row.count.value);
          return row.count.value;
        }),
        run: () => {},
      }),
    );
    expect(scoped(app, () => total.value)).toBe(4);
    evaluated.length = 0;

    row.count.value = 5;
    await row.increment(2);
    scoped(app, () => {
      row.count.value = 20;
    });

    expect(seen).toEqual([6, 8, 21]);
    expect(evaluated).toEqual([5, 7, 20]);
  });

  it("run an observer of a store resolved to another scope once per write", () => {
    const home: Scope = scope();
    const app = scope();
    const source = store(0);
    (source.node as Node).resolveScope = () => home;
    const doubled = computed(() => source.value * 2);
    const seen: number[] = [];
    scoped(app, () => reaction({ on: doubled, run: (value) => seen.push(value) }));
    expect(scoped(app, () => doubled.value)).toBe(0);
    scoped(home, () => {
      source.value = 2;
    });
    scoped(home, () => {
      source.value = 3;
    });
    expect(seen).toEqual([4, 6]);
  });
});

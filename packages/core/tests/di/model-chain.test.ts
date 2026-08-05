import { describe, expect, it } from "vitest";
import {
  computed,
  effect,
  event,
  lazyModel,
  onCleanup,
  owner,
  reaction,
  scope,
  scoped,
  store,
} from "../../lib";
import { flush } from "../support/async-flush";

// Long model chains are what a real feature looks like: a lazily loaded module
// exposing units, other models deriving from those, effects feeding them, and
// owners tearing the whole thing down. These probe the seams between them.
describe("long model chains", () => {
  it("derives across two lazily loaded models", async () => {
    const s = scope();
    const inner = lazyModel<{ bump: ReturnType<typeof event<number>>; $n: ReturnType<typeof store<number>> }>(
      async () => {
        const $n = store(1);
        const bump = event<number>();

        reaction({ on: bump, run: (v: number) => void ($n.value = v) });

        return { bump, $n };
      },
    );
    const seen: number[] = [];

    // Reading a lazy store before load throws by contract, so the load has to be
    // driven first — calling a lazy unit is what triggers it.
    await scoped(s, () => inner.bump(5));
    await flush(40);

    const $doubled = computed(() => inner.$n.value * 2);

    reaction({ on: $doubled, run: (v: number) => seen.push(v) });

    expect(scoped(s, () => $doubled.value)).toBe(10);

    await scoped(s, () => inner.bump(6));
    await flush(40);

    expect(seen.at(-1)).toBe(12);
  });

  it("keeps two scopes of the same lazy model apart", async () => {
    const a = scope();
    const b = scope();
    const model = lazyModel<{ set: ReturnType<typeof event<number>>; $n: ReturnType<typeof store<number>> }>(
      async () => {
        const $n = store(0);
        const set = event<number>();

        reaction({ on: set, run: (v: number) => void ($n.value = v) });

        return { set, $n };
      },
    );

    await scoped(a, () => model.set(1));
    await scoped(b, () => model.set(2));
    await flush(40);

    expect([scoped(a, () => model.$n.value), scoped(b, () => model.$n.value)]).toEqual([1, 2]);
  });

  it("runs an effect chain through a lazy model into a derived store", async () => {
    const s = scope();
    const model = lazyModel<{
      loadFx: ReturnType<typeof effect<number, string, unknown>>;
      $name: ReturnType<typeof store<string>>;
    }>(async () => {
      const $name = store("");
      const loadFx = effect<number, string, unknown>(async (id: number) => `user:${id}`);

      reaction({ on: loadFx.doneData, run: (value: string) => void ($name.value = value) });

      return { loadFx, $name };
    });
    // The lazy effect call loads the model; only then is its store readable.
    await scoped(s, () => model.loadFx(7));
    await flush(40);

    const $greeting = computed(() => `hi ${model.$name.value}`);

    expect(scoped(s, () => $greeting.value)).toBe("hi user:7");
  });

  it("cascades disposal to nested owners", () => {
    const order: string[] = [];
    const outer = owner(() => {
      onCleanup(() => order.push("outer"));

      const middle = owner(() => {
        onCleanup(() => order.push("middle"));

        const innerModel = owner(() => {
          onCleanup(() => order.push("inner"));

          return {};
        });

        return { innerModel };
      });

      return { middle };
    });

    outer.dispose();
    outer.dispose();

    // A model that builds sub-models no longer has to dispose them by hand.
    // The unwind runs innermost-first, so a child's cleanup can still rely on
    // whatever its parent is holding.
    expect(order).toEqual(["inner", "middle", "outer"]);

    // Disposing again changes nothing: every dispose is idempotent.
    outer.middle.innerModel.dispose();
    outer.middle.dispose();

    expect(order).toEqual(["inner", "middle", "outer"]);
  });

  it("stops every reaction in a disposed model chain", () => {
    const s = scope();
    const $source = store(0);
    const seen: string[] = [];

    const model = owner(() => {
      const $derived = $source.map((v) => v * 2);

      reaction({ on: $source, run: (v: number) => seen.push(`source:${v}`) });
      reaction({ on: $derived, run: (v: number) => seen.push(`derived:${v}`) });

      return {};
    });

    scoped(s, () => {
      $source.value = 1;
    });
    model.dispose();
    scoped(s, () => {
      $source.value = 2;
    });

    expect(seen).toEqual(["source:1", "derived:2"]);
  });

  it("aborts a model's in-flight effects when its owner is disposed", async () => {
    const s = scope();
    let started = false;
    const aborted: unknown[] = [];
    let ownedFx!: ReturnType<typeof effect<void, void, unknown>>;

    // The abort hook is registered where the EFFECT is created, not where it is
    // called — so the effect must belong to this owner.
    const model = owner(() => {
      ownedFx = effect<void, void, unknown>(
        () =>
          new Promise<void>(() => {
            started = true;
          }),
      );

      return {};
    });

    // The observer and the call live OUTSIDE the owner: anything registered
    // inside it is torn down by the same dispose we are trying to observe.
    reaction({ on: ownedFx.aborted, run: (value) => aborted.push(value) });

    const call = scoped(s, () => ownedFx()).catch(() => undefined);

    await flush(4);
    expect(started).toBe(true);

    model.dispose();
    await call;
    await flush(20);

    expect(aborted).toHaveLength(1);
    scoped(s, () => {
      expect(ownedFx.inFlight.value).toBe(0);
    });
  });

  it("keeps a five-link derived chain consistent under repeated updates", () => {
    const s = scope();
    const $raw = store(0);
    const $a = $raw.map((v) => v + 1);
    const $b = $a.map((v) => v * 2);
    const $c = computed(() => $b.value - 3);
    const $d = $c.map((v) => `#${v}`);
    const seen: string[] = [];

    reaction({ on: $d, run: (v: string) => seen.push(v) });

    scoped(s, () => {
      $raw.value = 1;
    });
    scoped(s, () => {
      $raw.value = 2;
    });
    scoped(s, () => {
      $raw.value = 3;
    });

    // (v+1)*2-3
    expect(seen).toEqual(["#1", "#3", "#5"]);
    expect(scoped(s, () => $d.value)).toBe("#5");
  });
});

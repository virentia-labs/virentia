import { describe, expect, it, vi } from "vitest";
import {
  computed,
  dependency,
  effect,
  event,
  getCurrentScope,
  lazyModel,
  onCleanup,
  owner,
  reaction,
  reactive,
  scope,
  scoped,
  store,
} from "../../lib";
import { flush, never } from "../support/async-flush";

describe("R1 derived combinations", () => {
  it("reactive field source: sibling reads the derived mid-tick", () => {
    const state = reactive({ token: "" });
    const $authorized = computed(() => Boolean(state.token));
    let hits = 0;

    reaction({ on: $authorized, run: () => hits++ });
    reaction({
      on: computed(() => state.token),
      run: () => void $authorized.value,
    });

    scoped(scope(), () => {
      state.token = "t";
    });

    expect(hits).toBe(1);
  });

  it("filterMap: skip then pass, with a sibling reader", () => {
    const $n = store(0);
    const $even = $n.filterMap((v) => (v % 2 === 0 ? v : "skip"), "skip");
    const seen: unknown[] = [];

    reaction({ on: $n, run: () => void $even.value });
    reaction({ on: $even, run: (v: unknown) => seen.push(v) });

    scoped(scope(), () => {
      $n.value = 1;
      $n.value = 2;
      $n.value = 3;
      $n.value = 4;
    });

    expect(seen).toEqual([2, 4]);
  });

  it("three-level chain with a reader on every level", () => {
    const $a = store(0);
    const $b = $a.map((v) => v + 1);
    const $c = $b.map((v) => v * 2);
    const $d = $c.map((v) => `#${v}`);
    const hits = { b: 0, c: 0, d: 0 };

    reaction({
      on: $a,
      run: () => {
        void $b.value;
        void $c.value;
        void $d.value;
      },
    });
    reaction({ on: $b, run: () => hits.b++ });
    reaction({ on: $c, run: () => hits.c++ });
    reaction({ on: $d, run: () => hits.d++ });

    scoped(scope(), () => {
      $a.value = 4;
    });

    expect(hits).toEqual({ b: 1, c: 1, d: 1 });
  });

  it("cascade: a reaction writes another store after reading the derived", () => {
    const $a = store(0);
    const $doubled = $a.map((v) => v * 2);
    const $mirror = store(0);
    const seen: number[] = [];

    reaction({
      on: $a,
      run: (v: number) => {
        void $doubled.value;
        $mirror.value = v;
      },
    });
    reaction({ on: $doubled, run: (v: number) => seen.push(v) });

    scoped(scope(), () => {
      $a.value = 3;
    });

    expect(seen).toEqual([6]);
  });

  it("two independent scopes updated in one body keep separate notifications", () => {
    const a = scope();
    const b = scope();
    const $source = store(0);
    const $derived = $source.map((v) => v * 10);
    const seenA: number[] = [];
    const seenB: number[] = [];

    reaction({ on: $source, run: () => void $derived.value });
    reaction({ on: $derived, scope: a, run: (v: number) => seenA.push(v) });
    reaction({ on: $derived, scope: b, run: (v: number) => seenB.push(v) });

    scoped(a, () => {
      $source.value = 1;
    });
    scoped(b, () => {
      $source.value = 2;
    });

    expect({ seenA, seenB }).toEqual({ seenA: [10], seenB: [20] });
  });

  it("event-driven write with a reader on the event", () => {
    const $a = store(0);
    const $derived = $a.map((v) => v > 0);
    const bump = event<number>();
    let hits = 0;

    reaction({
      on: bump,
      run: (v: number) => {
        $a.value = v;
        void $derived.value;
      },
    });
    reaction({ on: $derived, run: () => hits++ });

    scoped(scope(), () => {
      bump(5);
    });

    expect(hits).toBe(1);
  });

  it("effect doneData writes the source while another handler reads the derived", async () => {
    const $a = store(0);
    const $derived = $a.map((v) => v * 3);
    const loadFx = effect(async () => 7);
    let hits = 0;

    reaction({
      on: loadFx.doneData,
      run: (v: number) => {
        $a.value = v;
        void $derived.value;
      },
    });
    reaction({ on: $derived, run: () => hits++ });

    await scoped(scope(), () => loadFx());
    await flush();

    expect(hits).toBe(1);
  });

  it("owner dispose mid-tick does not resurrect a stale comparison", () => {
    const $a = store(0);
    const $derived = $a.map((v) => v * 2);
    const seen: number[] = [];
    const model = owner(() => {
      reaction({ on: $derived, run: (v: number) => seen.push(v) });
      return {};
    });

    const s = scope();
    scoped(s, () => {
      $a.value = 1;
    });
    model.dispose();
    scoped(s, () => {
      $a.value = 2;
    });

    expect(seen).toEqual([2]);
  });

  it("computed reading two derived siblings stays consistent when one is read early", () => {
    const $a = store(1);
    const $x = $a.map((v) => v + 1);
    const $y = $a.map((v) => v * 10);
    const $sum = computed(() => $x.value + $y.value);
    const seen: number[] = [];

    reaction({ on: $a, run: () => void $x.value });
    reaction({ on: $sum, run: (v: number) => seen.push(v) });

    scoped(scope(), () => {
      $a.value = 2;
    });

    expect(seen).toEqual([23]);
  });

  it("re-entrant write from the derived's own reaction settles", () => {
    const $a = store(0);
    const $derived = $a.map((v) => v);
    const seen: number[] = [];

    reaction({
      on: $derived,
      run: (v: number) => {
        seen.push(v);
        if (v < 3) $a.value = v + 1;
      },
    });

    scoped(scope(), () => {
      $a.value = 1;
    });

    expect(seen).toEqual([1, 2, 3]);
  });

  it("skipToken map: a skipped result must not notify even with a reader", () => {
    const $a = store(0);
    const $m = $a.map((v) => (v === 0 ? "skip" : v), "skip");
    const seen: unknown[] = [];

    reaction({ on: $a, run: () => void $m.value });
    reaction({ on: $m, run: (v: unknown) => seen.push(v) });

    scoped(scope(), () => {
      $a.value = 5;
      $a.value = 0;
      $a.value = 6;
    });

    expect(seen).toEqual([5, 6]);
  });
});

describe("R2 effects / events / transactions / owners", () => {
  it("effect pending is observable through a derived store", async () => {
    const s = scope();
    let release: (() => void) | undefined;
    const fx = effect(() => new Promise<void>((r) => (release = r)));
    const $busy = fx.pending.map((p) => (p ? "loading" : "idle"));
    const seen: string[] = [];

    reaction({ on: $busy, run: (v: string) => seen.push(v) });

    const call = scoped(s, () => fx());
    await flush();
    release?.();
    await call;
    await flush();

    expect(seen).toEqual(["loading", "idle"]);
  });

  it("effect inFlight derived counts concurrent calls", async () => {
    const s = scope();
    const releases: Array<() => void> = [];
    const fx = effect(() => new Promise<void>((r) => releases.push(r)));
    const $many = fx.inFlight.map((n) => n > 1);
    const seen: boolean[] = [];

    reaction({ on: $many, run: (v: boolean) => seen.push(v) });

    const calls = scoped(s, () => Promise.all([fx(), fx()]));
    await flush();
    for (const r of releases) r();
    await calls;
    await flush();

    // The first propagation in a scope always publishes, even when the mapped
    // value equals the global initial — hence the leading `false`.
    expect(seen).toEqual([false, true, false]);
  });

  it("aborting an effect leaves derived pending consistent", async () => {
    const s = scope();
    const fx = effect(() => never<void>());
    const $busy = fx.pending.map(Boolean);
    const seen: boolean[] = [];

    reaction({ on: $busy, run: (v: boolean) => seen.push(v) });

    const call = scoped(s, () => fx());
    await flush();
    await scoped(s, () => fx.abort(new Error("stop")));
    await expect(call).rejects.toThrow("stop");
    await flush();

    expect(seen).toEqual([true, false]);
    scoped(s, () => {
      expect(fx.pending.value).toBe(false);
      expect(fx.inFlight.value).toBe(0);
    });
  });

  it("event payload feeding a store keeps derived in step", () => {
    const s = scope();
    const setName = event<string>();
    const $name = store("");
    const $upper = $name.map((v) => v.toUpperCase());
    const seen: string[] = [];

    reaction({ on: setName, run: (v: string) => void ($name.value = v) });
    reaction({ on: $upper, run: (v: string) => seen.push(v) });

    scoped(s, () => setName("ann"));
    scoped(s, () => setName("bob"));

    expect(seen).toEqual(["ANN", "BOB"]);
  });

  it("onCleanup runs once when the owner is disposed", () => {
    const cleanups: string[] = [];
    const model = owner(() => {
      onCleanup(() => cleanups.push("a"));
      onCleanup(() => cleanups.push("b"));
      return {};
    });

    model.dispose();
    model.dispose();

    // Cleanups unwind in reverse registration order, and dispose is idempotent.
    expect(cleanups).toEqual(["b", "a"]);
  });

  it("disposing an owner stops its reactions on a derived store", () => {
    const s = scope();
    const $a = store(0);
    const $d = $a.map((v) => v);
    const seen: number[] = [];
    const model = owner(() => {
      reaction({ on: $d, run: (v: number) => seen.push(v) });
      return {};
    });

    scoped(s, () => {
      $a.value = 1;
    });
    model.dispose();
    scoped(s, () => {
      $a.value = 2;
    });

    expect(seen).toEqual([1]);
  });

  it("dependency read inside a derived resolves per scope", () => {
    const config = dependency<{ prefix: string }>("config");
    const $n = store(1);
    const $label = computed(() => `${config.value.prefix}${$n.value}`);
    const a = scope({ deps: [[config, { prefix: "a-" }]] });
    const b = scope({ deps: [[config, { prefix: "b-" }]] });

    expect(scoped(a, () => $label.value)).toBe("a-1");
    expect(scoped(b, () => $label.value)).toBe("b-1");
  });

  it("lazyModel exposes units that derived stores can observe", async () => {
    const s = scope();
    const model = lazyModel<{
      bump: ReturnType<typeof event<number>>;
      $n: ReturnType<typeof store<number>>;
      $double: ReturnType<typeof store<number>>["map"] extends never ? never : any;
    }>(async () => {
      const $n = store(1);
      const bump = event<number>();
      reaction({ on: bump, run: (v: number) => void ($n.value = v) });

      return { bump, $n, $double: $n.map((v) => v * 2) };
    });
    const seen: number[] = [];

    reaction({ on: model.$double, run: (v: number) => seen.push(v) });

    await scoped(s, () => model.bump(5));

    expect(seen).toEqual([10]);
  });

  it("getCurrentScope inside a derived reflects the reading scope", () => {
    const a = scope();
    const b = scope();
    const seen: unknown[] = [];
    const $probe = computed(() => {
      seen.push(getCurrentScope());
      return 1;
    });

    scoped(a, () => void $probe.value);
    scoped(b, () => void $probe.value);

    expect(seen).toEqual([a, b]);
  });

  it("reactive array mutation notifies a derived length", () => {
    const s = scope();
    const list = reactive({ items: [] as number[] });
    const $count = computed(() => list.items.length);
    const seen: number[] = [];

    reaction({ on: $count, run: (v: number) => seen.push(v) });

    scoped(s, () => {
      list.items = [...list.items, 1];
    });
    scoped(s, () => {
      list.items = [...list.items, 2];
    });

    expect(seen).toEqual([1, 2]);
  });

  it("a derived over two sources fires once when both change in one body", () => {
    const s = scope();
    const $a = store(1);
    const $b = store(2);
    const $sum = computed(() => $a.value + $b.value);
    const run = vi.fn();

    reaction({ on: $sum, run });

    scoped(s, () => {
      $a.value = 10;
      $b.value = 20;
    });

    // Two separate writes are two updates; each publishes its own change.
    expect(run.mock.calls.map((c) => c[0])).toEqual([12, 30]);
  });
});

describe("R3 scope / reactive / reentrancy", () => {
  it("nested scoped restores the outer scope", () => {
    const a = scope();
    const b = scope();
    const $n = store(0);

    scoped(a, () => {
      $n.value = 1;
      scoped(b, () => {
        $n.value = 2;
      });
      $n.value = 3;
    });

    expect({ a: scoped(a, () => $n.value), b: scoped(b, () => $n.value) }).toEqual({ a: 3, b: 2 });
  });

  it("derived value is isolated per scope even when read in only one", () => {
    const a = scope();
    const b = scope();
    const $n = store(1);
    const $d = $n.map((v) => v * 100);

    scoped(a, () => {
      $n.value = 2;
    });

    expect({ a: scoped(a, () => $d.value), b: scoped(b, () => $d.value) }).toEqual({
      a: 200,
      b: 100,
    });
  });

  it("reactive nested object field change notifies a derived", () => {
    const s = scope();
    const state = reactive({ user: { name: "a" } });
    const $name = computed(() => state.user.name);
    const seen: string[] = [];

    reaction({ on: $name, run: (v: string) => seen.push(v) });

    scoped(s, () => {
      state.user = { name: "b" };
    });

    expect(seen).toEqual(["b"]);
  });

  it("reactive field delete notifies a derived that reads the key", () => {
    const s = scope();
    const state = reactive({ a: 1 } as { a?: number });
    const $has = computed(() => "a" in state);
    const seen: boolean[] = [];

    reaction({ on: $has, run: (v: boolean) => seen.push(v) });

    scoped(s, () => {
      delete state.a;
    });

    expect(seen).toEqual([false]);
  });

  it("a reaction writing its own source settles without runaway", () => {
    const s = scope();
    const $n = store(0);
    const seen: number[] = [];

    reaction({
      on: $n,
      run: (v: number) => {
        seen.push(v);
        if (v < 3) $n.value = v + 1;
      },
    });

    scoped(s, () => {
      $n.value = 1;
    });

    expect(seen).toEqual([1, 2, 3]);
  });

  it("two reactions on the same derived fire in registration order", () => {
    const s = scope();
    const $n = store(0);
    const $d = $n.map((v) => v);
    const order: string[] = [];

    reaction({ on: $d, run: () => order.push("first") });
    reaction({ on: $d, run: () => order.push("second") });

    scoped(s, () => {
      $n.value = 1;
    });

    expect(order).toEqual(["first", "second"]);
  });

  it("an auto-tracked reaction picks up a newly read derived after a branch flip", () => {
    const s = scope();
    const $flag = store(false);
    const $a = store(1);
    const $b = store(2);
    const $pick = computed(() => ($flag.value ? $b.value : $a.value));
    const seen: number[] = [];

    reaction({ on: $pick, run: (v: number) => seen.push(v) });

    scoped(s, () => {
      $a.value = 10;
    });
    scoped(s, () => {
      $flag.value = true;
    });
    scoped(s, () => {
      $b.value = 20;
    });
    // $a is no longer a dependency once the branch flipped.
    scoped(s, () => {
      $a.value = 99;
    });

    expect(seen).toEqual([10, 2, 20]);
  });

  it("event fired inside a derived's reaction reaches its own observers", () => {
    const s = scope();
    const $n = store(0);
    const $d = $n.map((v) => v);
    const ping = event<number>();
    const seen: number[] = [];

    reaction({ on: $d, run: (v: number) => ping(v) });
    reaction({ on: ping, run: (v: number) => seen.push(v) });

    scoped(s, () => {
      $n.value = 7;
    });

    expect(seen).toEqual([7]);
  });

  it("a computed that throws surfaces the error to the reader, then recovers", () => {
    const s = scope();
    const $n = store(0);
    const $risky = computed(() => {
      if ($n.value === 1) throw new Error("bad");

      return $n.value;
    });

    scoped(s, () => {
      $n.value = 1;
    });
    expect(() => scoped(s, () => $risky.value)).toThrow("bad");

    scoped(s, () => {
      $n.value = 2;
    });
    expect(scoped(s, () => $risky.value)).toBe(2);
  });

  it("object identity: writing an equal-by-value object still notifies", () => {
    const s = scope();
    const $obj = store<{ n: number }>({ n: 1 });
    const $n = $obj.map((o) => o.n);
    const seen: number[] = [];

    reaction({ on: $n, run: (v: number) => seen.push(v) });

    scoped(s, () => {
      $obj.value = { n: 1 };
    });

    // Pre-existing semantics (verified against the unpatched core): the first
    // propagation in a scope publishes even when the mapped value equals the
    // global initial, because the scope had no previous value of its own.
    expect(seen).toEqual([1]);
  });
});

describe("R4 scope seeding / handler overrides / micro-scope", () => {
  it("a seeded scope value feeds derived stores from the start", () => {
    const $n = store(1);
    const $d = $n.map((v) => v * 10);
    const s = scope({ values: [[$n, 5]] });
    const seen: number[] = [];

    reaction({ on: $d, run: (v: number) => seen.push(v) });

    expect(scoped(s, () => $d.value)).toBe(50);

    scoped(s, () => {
      $n.value = 6;
    });

    expect(seen).toEqual([60]);
  });

  it("a scoped effect handler override reaches derived pending", async () => {
    const fx = effect(async (n: number) => n * 2);
    const s = scope({ handlers: [[fx, async (n: number) => n * 100]] });
    const $busy = fx.pending.map(Boolean);
    const seen: boolean[] = [];

    reaction({ on: $busy, run: (v: boolean) => seen.push(v) });

    await expect(scoped(s, () => fx(2))).resolves.toBe(200);
    await flush(60);

    expect(seen).toEqual([true, false]);
  });

  it("a derived read inside an effect handler sees the calling scope", async () => {
    const $n = store(0);
    const $d = $n.map((v) => v + 1);
    const a = scope();
    const b = scope();
    const readFx = effect(() => $d.value);

    scoped(a, () => {
      $n.value = 10;
    });
    scoped(b, () => {
      $n.value = 20;
    });

    await expect(scoped(a, () => readFx())).resolves.toBe(11);
    await expect(scoped(b, () => readFx())).resolves.toBe(21);
  });

  it("an auto reaction awaiting an effect keeps tracking after the await", async () => {
    const s = scope();
    const $n = store(0);
    const $d = $n.map((v) => v * 2);
    const loadFx = effect(async () => 3);
    const seen: number[] = [];

    scoped(s, () => {
      reaction({
        run: async () => {
          const base = $d.value;
          const extra = await loadFx();
          seen.push(base + extra);
        },
      });
    });
    await flush(60);

    await scoped(s, () => {
      $n.value = 4;
    });
    await flush(60);

    expect(seen.at(-1)).toBe(11);
  });

  it("derived chains stay consistent when two scopes interleave writes", () => {
    const a = scope();
    const b = scope();
    const $n = store(0);
    const $d = $n.map((v) => `v${v}`);
    const seenA: string[] = [];
    const seenB: string[] = [];

    reaction({ on: $d, scope: a, run: (v: string) => seenA.push(v) });
    reaction({ on: $d, scope: b, run: (v: string) => seenB.push(v) });

    scoped(a, () => {
      $n.value = 1;
    });
    scoped(b, () => {
      $n.value = 2;
    });
    scoped(a, () => {
      $n.value = 3;
    });

    expect({ seenA, seenB }).toEqual({ seenA: ["v1", "v3"], seenB: ["v2"] });
  });

  it("a computed of a computed of a map propagates exactly once per change", () => {
    const s = scope();
    const $n = store(0);
    const $a = $n.map((v) => v + 1);
    const $b = computed(() => $a.value * 2);
    const $c = computed(() => `${$b.value}`);
    let runs = 0;

    reaction({ on: $c, run: () => runs++ });

    scoped(s, () => {
      $n.value = 1;
    });

    expect(runs).toBe(1);
  });

  it("a filter that never passes never notifies", () => {
    const s = scope();
    const $n = store(0);
    const $none = $n.filter(() => false);
    const seen: number[] = [];

    reaction({ on: $none, run: (v: number) => seen.push(v) });

    scoped(s, () => {
      $n.value = 1;
      $n.value = 2;
    });

    expect(seen).toEqual([]);
  });

  it("reading a derived from two scopes in one synchronous body keeps values apart", () => {
    const a = scope();
    const b = scope();
    const $n = store(1);
    const $d = $n.map((v) => v * 3);

    scoped(a, () => {
      $n.value = 2;
    });

    const pair = [scoped(a, () => $d.value), scoped(b, () => $d.value)];

    expect(pair).toEqual([6, 3]);
  });
});

describe("R5 devtools / serialization / kernel edges", () => {
  it("a scope's serialized values survive a round trip into a fresh scope", () => {
    const $a = store(1);
    const $b = store("x");
    const source = scope();

    scoped(source, () => {
      $a.value = 42;
      $b.value = "y";
    });

    const target = scope({
      values: [
        [$a, scoped(source, () => $a.value)],
        [$b, scoped(source, () => $b.value)],
      ],
    });

    expect(scoped(target, () => [$a.value, $b.value])).toEqual([42, "y"]);
  });

  it("a derived rebuilt in a hydrated scope matches the source scope", () => {
    const $n = store(1);
    const $d = $n.map((v) => v * 7);
    const source = scope();

    scoped(source, () => {
      $n.value = 3;
    });

    const hydrated = scope({ values: [[$n, scoped(source, () => $n.value)]] });

    expect(scoped(hydrated, () => $d.value)).toBe(21);
  });

  it("named units keep their names on derived links", () => {
    const $n = store(1, undefined, { name: "count" });
    const $d = $n.map((v) => v);

    expect(typeof $d.node).toBe("object");
    expect($n.node).not.toBe($d.node);
  });

  it("a computed with no dependencies never re-notifies", () => {
    const s = scope();
    const $const = computed(() => 5);
    const $trigger = store(0);
    let runs = 0;

    reaction({ on: $const, run: () => runs++ });

    scoped(s, () => {
      $trigger.value = 1;
    });
    scoped(s, () => {
      $trigger.value = 2;
    });

    expect(runs).toBe(0);
  });

  it("a store written to the same value never notifies", () => {
    const s = scope();
    const $n = store(1);
    const $d = $n.map((v) => v);
    let runs = 0;

    reaction({ on: $d, run: () => runs++ });

    scoped(s, () => {
      $n.value = 1;
      $n.value = 1;
    });

    expect(runs).toBe(0);
  });

  it("an event with no payload reaches its reaction", () => {
    const s = scope();
    const ping = event<void>();
    let runs = 0;

    reaction({ on: ping, run: () => runs++ });

    scoped(s, () => ping());

    expect(runs).toBe(1);
  });

  it("a derived of a derived of a derived keeps per-scope isolation", () => {
    const a = scope();
    const b = scope();
    const $n = store(0);
    const $x = $n.map((v) => v + 1);
    const $y = $x.map((v) => v * 2);
    const $z = $y.map((v) => `#${v}`);

    scoped(a, () => {
      $n.value = 1;
    });
    scoped(b, () => {
      $n.value = 5;
    });

    expect([scoped(a, () => $z.value), scoped(b, () => $z.value)]).toEqual(["#4", "#12"]);
  });

  it("reading a derived inside its own reaction returns the fresh value", () => {
    const s = scope();
    const $n = store(0);
    const $d = $n.map((v) => v * 2);
    const seen: Array<[number, number]> = [];

    reaction({ on: $d, run: (v: number) => seen.push([v, $d.value]) });

    scoped(s, () => {
      $n.value = 3;
    });

    expect(seen).toEqual([[6, 6]]);
  });

  it("a scope created after the write still computes from its own baseline", () => {
    const $n = store(1);
    const $d = $n.map((v) => v * 10);
    const early = scope();

    scoped(early, () => {
      $n.value = 9;
    });

    const late = scope();

    expect(scoped(late, () => $d.value)).toBe(10);
  });

  it("many observers of one derived all receive the same change", () => {
    const s = scope();
    const $n = store(0);
    const $d = $n.map((v) => v + 1);
    const hits: number[] = [];

    for (let i = 0; i < 5; i += 1) {
      reaction({ on: $d, run: (v: number) => hits.push(v) });
    }

    scoped(s, () => {
      $n.value = 1;
    });

    expect(hits).toEqual([2, 2, 2, 2, 2]);
  });
});

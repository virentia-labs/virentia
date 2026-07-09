import { describe, expect, expectTypeOf, it } from "vitest";
import { computed, event, reaction, scope, scoped } from "@virentia/core";
import type { Node, Scope, Store } from "@virentia/core";
import { mutableStore, seedMutableStore, unwrap } from "../lib";

// ---------------------------------------------------------------------------
// Shared harness helpers.
//
// The fine-grained reactivity is scope-parameterized: a computed only registers
// its keypath dependencies when it is evaluated inside a scope that reads the
// store, and a commit only re-runs readers that live in that scope. So every
// reactive test: (1) creates the computed, (2) wires a counting reaction on it
// plus a mutating reaction on an event, (3) evaluates the computed once inside
// the scope to register deps, (4) resets the counter, (5) fires the event via
// `await scoped(...)` (event-driven reactions flush on a microtask).
// ---------------------------------------------------------------------------

describe("mutableStore — shape & scope guards", () => {
  it("MS-1: exposes node, writable:true, value, subscribe, map", () => {
    const state = mutableStore({ a: 1 });
    expect(typeof state.node).toBe("object");
    expect(state.writable).toBe(true);
    expect(typeof state.subscribe).toBe("function");
    expect(typeof state.map).toBe("function");
    // `value` is a getter/setter — descriptor lives on the object.
    const desc = Object.getOwnPropertyDescriptor(state, "value");
    expect(typeof desc?.get).toBe("function");
    expect(typeof desc?.set).toBe("function");
  });

  it("MS-2: reading .value with no active scope throws a scope-required error", () => {
    const state = mutableStore({ a: 1 });
    expect(() => state.value).toThrow(/read a mutable store/);
  });

  it("MS-3: assigning .value with no active scope throws a scope-required error", () => {
    const state = mutableStore({ a: 1 });
    expect(() => {
      state.value = { a: 2 };
    }).toThrow(/write a mutable store/);
  });

  it("MS-2: map's tracked read outside a scope throws when the computed is forced", () => {
    const state = mutableStore({ a: 1 });
    const doubled = state.map((v) => v.a * 2);
    // The computed reads the store, which requires a scope (the computed layer's
    // guard reports first, but it is still a scope-required failure).
    expect(() => scoped(scope(), () => doubled.value)).not.toThrow();
    expect(() => doubled.value).toThrow(/Scope is required/);
  });
});

describe("mutableStore — copy-on-write ownership", () => {
  it("MS-4/COW-1: first divergence never mutates initial; untouched siblings shared", () => {
    const initial = { a: { v: 1 }, b: { v: 2 } };
    const state = mutableStore(initial);
    const s = scope();

    scoped(s, () => {
      state.value.a.v = 10;
    });

    expect(initial).toEqual({ a: { v: 1 }, b: { v: 2 } });
    scoped(s, () => {
      expect(unwrap(state.value.a)).not.toBe(initial.a);
      expect(unwrap(state.value.b)).toBe(initial.b);
    });
  });

  it("COW-2: a deep write copies the ancestor chain but shares unrelated branches", () => {
    const initial = { a: { b: { c: 1 }, sib: { keep: true } }, other: { z: 0 } };
    const snapshot = JSON.parse(JSON.stringify(initial));
    const state = mutableStore(initial);
    const s = scope();

    scoped(s, () => {
      state.value.a.b.c = 2;
    });

    scoped(s, () => {
      expect(unwrap(state.value.a)).not.toBe(initial.a);
      expect(unwrap(state.value.a.b)).not.toBe(initial.a.b);
      expect(unwrap(state.value.a.sib)).toBe(initial.a.sib);
      expect(unwrap(state.value.other)).toBe(initial.other);
      expect(state.value.a.b.c).toBe(2);
    });
    // initial is byte-for-byte unchanged.
    expect(initial).toEqual(snapshot);
  });

  it("OWN-1: owned nodes are mutated in place → stable unwrap identity across commits", () => {
    const state = mutableStore({ list: [] as number[] });
    const s = scope();

    scoped(s, () => state.value.list.push(1));
    const firstRef = scoped(s, () => unwrap(state.value.list));
    scoped(s, () => state.value.list.push(2));
    const secondRef = scoped(s, () => unwrap(state.value.list));

    expect([...secondRef]).toEqual([1, 2]);
    expect(secondRef).toBe(firstRef);
  });

  it("OWN-2: after first divergence an owned node is mutated in place mid-transaction", () => {
    const state = mutableStore({ n: 0 });
    const s = scope();

    // First divergence copies-on-write and commits an owned object.
    scoped(s, () => {
      state.value.n = 1;
    });
    const committedRef = scoped(s, () => unwrap(state.value));

    // A later transaction mutates that same owned object in place BEFORE the
    // commit boundary — so the previously-committed reference is observed
    // changing mid-flight. This documents that pre-commit atomicity only holds
    // on the first divergence / a wholesale replace.
    scoped(s, () => {
      state.value.n = 5;
      expect((committedRef as { n: number }).n).toBe(5);
    });
  });

  it("ASSIGN-1: an external object assigned into the tree is never mutated", () => {
    const external = { k: 1 };
    const state = mutableStore({ ref: null as null | { k: number } });
    const s = scope();

    scoped(s, () => (state.value.ref = external));
    scoped(s, () => (state.value.ref!.k = 2));

    expect(external.k).toBe(1);
    expect(scoped(s, () => state.value.ref!.k)).toBe(2);
  });

  it("ASSIGN-2: assigning a draft proxy stores its raw underlying object", () => {
    const state = mutableStore({ src: { k: 1 }, dst: null as null | { k: number } });
    const s = scope();

    scoped(s, () => {
      state.value.dst = state.value.src; // src read is a draft proxy; set unwraps it
    });

    scoped(s, () => {
      // The stored value is the raw object, not a nested proxy.
      expect(unwrap(state.value.dst)).toBe(unwrap(state.value.src));
    });
  });
});

describe("mutableStore — leaves (Date/Map/Set/class)", () => {
  it("LEAF-1: Map/Set/class instances are raw leaves, replaced wholesale", () => {
    const map0 = new Map<number, number>();
    class C {
      v = 1;
    }
    const state = mutableStore({ m: map0, tag: new C() });
    const s = scope();

    scoped(s, () => {
      expect(unwrap(state.value.m)).toBe(map0); // raw, not a proxy
      expect(state.value.tag).toBeInstanceOf(C);
      state.value.m = new Map([[1, 2]]);
    });

    scoped(s, () => {
      expect(state.value.m.get(1)).toBe(2);
      expect(unwrap(state.value.m)).not.toBe(map0);
    });
  });

  it("LEAF-1 edge: a leaf Set is the real instance and its methods work", () => {
    const state = mutableStore({ s: new Set([1]) });
    const s = scope();
    scoped(s, () => {
      expect(state.value.s.has(1)).toBe(true);
      expect(state.value.s).toBeInstanceOf(Set);
      // The leaf is not a draft proxy: unwrap is an identity here.
      expect(unwrap(state.value.s)).toBe(state.value.s);
    });
  });

  it("LEAF-2: mutating a Date leaf in place contaminates initial and does not notify", async () => {
    const initial = { when: new Date(0) };
    const state = mutableStore(initial);
    const x = scope();
    const y = scope();
    const bump = event<void>();

    const whenTime = computed(() => state.value.when.getTime());
    let runs = 0;
    reaction({ on: whenTime, run: () => void runs++ });
    reaction({ on: bump, run: () => void state.value.when.setTime(5) });

    scoped(x, () => void whenTime.value);
    runs = 0;

    await scoped(x, () => bump());

    // The shared base Date was mutated in place — contaminating `initial`.
    expect(initial.when.getTime()).toBe(5);
    // Another scope sees the contamination too (shared base object).
    expect(scoped(y, () => state.value.when.getTime())).toBe(5);
    // No onChange fired for an in-place leaf mutation → no reactive re-run.
    expect(runs).toBe(0);
  });
});

describe("mutableStore — arrays", () => {
  it("ARR-1: sort/reverse/fill/copyWithin/splice produce correct arrays", () => {
    const s = scope();
    const state = mutableStore({ a: [3, 1, 2, 5, 4] });
    scoped(s, () => {
      state.value.a.sort((x, y) => x - y); // [1,2,3,4,5]
      state.value.a.reverse(); // [5,4,3,2,1]
      state.value.a.fill(0, 0, 1); // [0,4,3,2,1]
      state.value.a.copyWithin(0, 3); // [2,1,3,2,1]
      expect([...state.value.a]).toEqual([2, 1, 3, 2, 1]);
    });
  });

  it("ARR-2: a reader of items[0] re-runs exactly once on splice at index 0", async () => {
    const s = scope();
    const doSplice = event<void>();
    const cart = mutableStore({ items: [1, 2, 3] });
    const first = computed(() => cart.value.items[0]);
    let runs = 0;
    reaction({ on: first, run: () => void runs++ });
    reaction({ on: doSplice, run: () => void cart.value.items.splice(0, 1) });

    scoped(s, () => void first.value);
    runs = 0;

    await scoped(s, () => doSplice());
    expect(runs).toBe(1);
    expect(scoped(s, () => first.value)).toBe(2);
  });

  it("ARR-3: array mutator unwraps its arguments (pushing a proxy stores raw)", () => {
    const state = mutableStore({ src: { k: 1 }, list: [] as { k: number }[] });
    const s = scope();
    scoped(s, () => state.value.list.push(state.value.src));
    scoped(s, () => {
      expect(unwrap(state.value.list[0])).toBe(unwrap(state.value.src));
    });
  });

  it("ARR-3: array mutator clears cached child drafts", () => {
    const state = mutableStore({ items: [{ id: 0 }] as { id: number }[] });
    const s = scope();
    scoped(s, () => {
      const before = state.value.items[0];
      state.value.items.push({ id: 1 });
      const after = state.value.items[0];
      // The cache was cleared, but both resolve to the same underlying object.
      expect(unwrap(after)).toBe(unwrap(before));
      // Mutating via the freshly-derived proxy affects the current array copy.
      after.id = 99;
      expect(state.value.items[0].id).toBe(99);
    });
  });

  it("ARR-4: arr.length = 0 truncates via the set trap and re-runs a length reader", async () => {
    const s = scope();
    const trunc = event<void>();
    const state = mutableStore({ items: [1, 2, 3] });
    const len = computed(() => state.value.items.length);
    let runs = 0;
    reaction({ on: len, run: () => void runs++ });
    reaction({ on: trunc, run: () => void (state.value.items.length = 0) });

    scoped(s, () => void len.value);
    runs = 0;

    await scoped(s, () => trunc());
    expect(runs).toBe(1);
    expect(scoped(s, () => [...state.value.items])).toEqual([]);
  });

  it("ARR-4: direct index assignment fires the exact index path only", async () => {
    const s = scope();
    const setZero = event<void>();
    const state = mutableStore({ items: [1, 2, 3] });
    const a0 = computed(() => state.value.items[0]);
    const a2 = computed(() => state.value.items[2]);
    let runsA = 0;
    let runsB = 0;
    reaction({ on: a0, run: () => void runsA++ });
    reaction({ on: a2, run: () => void runsB++ });
    reaction({ on: setZero, run: () => void (state.value.items[0] = 9) });

    scoped(s, () => {
      void a0.value;
      void a2.value;
    });
    runsA = 0;
    runsB = 0;

    await scoped(s, () => setZero());
    expect(runsA).toBe(1);
    expect(runsB).toBe(0);
    expect(scoped(s, () => [...state.value.items])).toEqual([9, 2, 3]);
  });
});

describe("mutableStore — keypath granularity", () => {
  it("PATH-READ-1: replacing an ancestor invalidates a deep reader", async () => {
    const s = scope();
    const replaceA = event<void>();
    const doc = mutableStore({ a: { x: 0 } });
    const deep = computed(() => doc.value.a.x);
    let runs = 0;
    reaction({ on: deep, run: () => void runs++ });
    reaction({ on: replaceA, run: () => void (doc.value.a = { x: 5 }) });

    scoped(s, () => void deep.value);
    runs = 0;

    await scoped(s, () => replaceA());
    expect(runs).toBe(1);
    expect(scoped(s, () => deep.value)).toBe(5);
  });

  it("PATH-WRITE-1: editing a sibling path does not re-run another path's reader", async () => {
    const s = scope();
    const editA = event<void>();
    const doc = mutableStore({ a: { x: 0 }, b: { y: 0 } });
    const bv = computed(() => doc.value.b.y);
    let bRuns = 0;
    reaction({ on: bv, run: () => void bRuns++ });
    reaction({ on: editA, run: () => void (doc.value.a.x = 1) });

    scoped(s, () => void bv.value);
    bRuns = 0;

    await scoped(s, () => editA());
    expect(bRuns).toBe(0);
  });

  it("PATH-NEW-1: adding a new key re-runs an enumerator; changing an existing one does not", async () => {
    const s = scope();
    const setExisting = event<void>();
    const addKey = event<void>();
    const state = mutableStore({ obj: { a: 1 } as Record<string, number> });
    const keyCount = computed(() => Object.keys(state.value.obj).length);
    let runs = 0;
    reaction({ on: keyCount, run: () => void runs++ });
    reaction({ on: setExisting, run: () => void (state.value.obj.a = 2) });
    reaction({ on: addKey, run: () => void (state.value.obj.b = 5) });

    scoped(s, () => void keyCount.value);
    runs = 0;

    await scoped(s, () => setExisting());
    expect(runs).toBe(0); // existing key value change: no shape change

    await scoped(s, () => addKey());
    expect(runs).toBe(1); // new key: parent node path fired
    expect(scoped(s, () => keyCount.value)).toBe(2);
  });

  it("PATH-NEW-1: a symbol-keyed set fires the node path (enumeration reader re-runs)", async () => {
    const K = Symbol("k");
    const s = scope();
    const setSym = event<void>();
    const state = mutableStore({ obj: {} as Record<string | symbol, number> });
    // Reflect.ownKeys counts symbol keys too, so the value changes on the symbol
    // set — proving the node-path fire reached this enumeration reader.
    const keyCount = computed(() => Reflect.ownKeys(state.value.obj).length);
    let runs = 0;
    reaction({ on: keyCount, run: () => void runs++ });
    reaction({ on: setSym, run: () => void (state.value.obj[K] = 1) });

    scoped(s, () => void keyCount.value);
    runs = 0;

    await scoped(s, () => setSym());
    expect(runs).toBe(1); // symbol set reports state.path (node path)
    expect(scoped(s, () => state.value.obj[K])).toBe(1);
  });

  it("PATH-DEL-1: deleting an existing key re-runs an enumerator; deleting an absent key does not", async () => {
    const s = scope();
    const delA = event<void>();
    const delNope = event<void>();
    const state = mutableStore({ obj: { a: 1 } as Record<string, number> });
    const keyCount = computed(() => Object.keys(state.value.obj).length);
    let runs = 0;
    reaction({ on: keyCount, run: () => void runs++ });
    reaction({ on: delNope, run: () => void delete state.value.obj.nope });
    reaction({ on: delA, run: () => void delete state.value.obj.a });

    scoped(s, () => void keyCount.value);
    runs = 0;

    await scoped(s, () => delNope());
    expect(runs).toBe(0); // absent key: no shape change fired

    await scoped(s, () => delA());
    expect(runs).toBe(1);
    expect(scoped(s, () => keyCount.value)).toBe(0);
  });

  it("STRUCT-READ-1: `'x' in value` registers a structural dep that re-runs when x is added", async () => {
    const s = scope();
    const addX = event<void>();
    const state = mutableStore({ obj: {} as Record<string, number> });
    const hasX = computed(() => "x" in state.value.obj);
    let runs = 0;
    let last = false;
    reaction({ on: hasX, run: () => {
      runs++;
      last = scoped(s, () => hasX.value);
    } });
    reaction({ on: addX, run: () => void (state.value.obj.x = 1) });

    scoped(s, () => void hasX.value);
    runs = 0;

    await scoped(s, () => addX());
    expect(runs).toBe(1);
    expect(last).toBe(true);
  });

  it("STRUCT-READ-2: a getOwnPropertyDescriptor reader does NOT track the leaf value (goes stale)", async () => {
    const s = scope();
    const bump = event<void>();
    const state = mutableStore({ obj: { a: 1 } as Record<string, number> });
    // Direct-index reader tracks obj.a; gOPD reader only descends to obj.
    const direct = computed(() => state.value.obj.a);
    const viaDescriptor = computed(
      () => Object.getOwnPropertyDescriptor(state.value.obj, "a")?.value as number,
    );
    let directRuns = 0;
    let descRuns = 0;
    reaction({ on: direct, run: () => void directRuns++ });
    reaction({ on: viaDescriptor, run: () => void descRuns++ });
    reaction({ on: bump, run: () => void (state.value.obj.a = 2) });

    scoped(s, () => {
      void direct.value;
      void viaDescriptor.value;
    });
    directRuns = 0;
    descRuns = 0;

    await scoped(s, () => bump());
    expect(directRuns).toBe(1); // tracked → re-runs
    // getOwnPropertyDescriptor omits onRead, so the existing-key value change is
    // not observed by this reader. Documented asymmetry / possible latent bug.
    expect(descRuns).toBe(0);
  });

  it("RX-COARSE-2: unwrap of a nested subtree still takes a whole-store coarse dependency", async () => {
    const s = scope();
    const bumpB = event<void>();
    const state = mutableStore({ a: { x: 0 }, b: 0 });
    // Returns a fresh object each eval so the downstream reaction fires on every
    // recompute — letting us observe the coarse (over-)subscription directly.
    const c = computed(() => ({ x: unwrap(state.value.a).x }));
    let runs = 0;
    reaction({ on: c, run: () => void runs++ });
    reaction({ on: bumpB, run: () => void (state.value.b += 1) });

    scoped(s, () => void c.value);
    runs = 0;

    await scoped(s, () => bumpB());
    // Even though `c` only unwrapped subtree `a`, unwrap → onReadAll → storeNode,
    // so the unrelated `b` commit re-runs it.
    expect(runs).toBe(1);
  });

  it("RX-FINE-2: a wholesale replace re-runs every live path reader, even now-absent paths", async () => {
    const s = scope();
    const replace = event<void>();
    const state = mutableStore({ a: 1, b: 2 } as { a: number; b?: number });
    const av = computed(() => state.value.a);
    const bv = computed(() => state.value.b);
    let aRuns = 0;
    let bRuns = 0;
    reaction({ on: av, run: () => void aRuns++ });
    reaction({ on: bv, run: () => void bRuns++ });
    reaction({ on: replace, run: () => void (state.value = { a: 9 }) });

    scoped(s, () => {
      void av.value;
      void bv.value;
    });
    aRuns = 0;
    bRuns = 0;

    await scoped(s, () => replace());
    expect(aRuns).toBe(1);
    expect(bRuns).toBe(1); // b path fired even though b is absent in the new value
    expect(scoped(s, () => state.value.a)).toBe(9);
    expect(scoped(s, () => state.value.b)).toBeUndefined();
  });

  it("RX-LAZY-1: changing a never-read path fires only subscribers/storeNode", async () => {
    const s = scope();
    const bumpB = event<void>();
    const state = mutableStore({ a: 0, b: 0 });
    // A fine reader of `a` only; nobody ever read `b`.
    const av = computed(() => state.value.a);
    let aRuns = 0;
    let subCalls = 0;
    reaction({ on: av, run: () => void aRuns++ });
    reaction({ on: bumpB, run: () => void (state.value.b += 1) });
    state.subscribe(() => subCalls++);

    scoped(s, () => void av.value);
    aRuns = 0;

    await scoped(s, () => bumpB());
    expect(subCalls).toBe(1); // coarse subscriber fires
    expect(aRuns).toBe(0); // the `a` reader is untouched by a `b` change
  });
});

describe("mutableStore — transactions", () => {
  it("TX-2: many mutations in one reaction batch into a single commit", async () => {
    const s = scope();
    const go = event<void>();
    const state = mutableStore({ n: 0, other: 0 });
    let calls = 0;
    state.subscribe(() => calls++);
    reaction({
      on: go,
      run() {
        state.value.n++;
        state.value.n++;
        state.value.n++;
        state.value.n++;
        state.value.n++;
        state.value.other++;
        state.value.other++;
      },
    });

    await scoped(s, () => go());
    expect(calls).toBe(1); // single finalize
    expect(scoped(s, () => state.value.n)).toBe(5);
    expect(scoped(s, () => state.value.other)).toBe(2);
  });

  it("TX-3: a plain scoped mutation commits at the scoped boundary (synchronous)", () => {
    const s = scope();
    const state = mutableStore({ a: 0 });
    let calls = 0;
    state.subscribe(() => calls++);
    scoped(s, () => {
      state.value.a = 1;
    });
    expect(calls).toBe(1);
  });

  it("TX-4: a pure read scope neither commits nor notifies", () => {
    const s = scope();
    const state = mutableStore({ a: 0 });
    let calls = 0;
    state.subscribe(() => calls++);
    scoped(s, () => void state.value.a);
    expect(calls).toBe(0);
    // Committed still falls back to the initial value.
    expect(scoped(s, () => state.value.a)).toBe(0);
  });

  it("TX-5: a replace followed by mutations commits atomically as the combined result", async () => {
    const s = scope();
    const go = event<void>();
    const state = mutableStore({ a: 0, b: 0 });
    const seen: Array<{ a: number; b: number }> = [];
    state.subscribe((v) => seen.push({ ...v }));
    reaction({
      on: go,
      run() {
        state.value = { a: 1, b: 1 };
        state.value.a = 2;
      },
    });

    await scoped(s, () => go());
    expect(seen).toEqual([{ a: 2, b: 1 }]);
  });

  it("TX-6: a fresh draft is opened after commit — new proxy identity, value carried over", () => {
    const state = mutableStore({ a: 0 });
    const s = scope();
    scoped(s, () => {
      state.value.a = 1;
    });
    const p1 = scoped(s, () => state.value);
    scoped(s, () => {
      state.value.a = 2;
    });
    const p2 = scoped(s, () => state.value);
    expect(p1).not.toBe(p2); // draft recreated per transaction
    expect(scoped(s, () => state.value.a)).toBe(2);
  });
});

describe("mutableStore — replace", () => {
  it("REPLACE-1: the replacement source object is not mutated by a later in-draft write", () => {
    const next = { a: 0 };
    const state = mutableStore({ a: 5 });
    const s = scope();
    scoped(s, () => {
      state.value = next;
      state.value.a = 7;
    });
    expect(next.a).toBe(0); // copy-on-write on the replacement
    expect(scoped(s, () => state.value.a)).toBe(7);
  });

  it("REPLACE-3: the last replace wins within one transaction", async () => {
    const s = scope();
    const go = event<void>();
    const state = mutableStore({ a: 0 });
    let calls = 0;
    state.subscribe(() => calls++);
    reaction({
      on: go,
      run() {
        state.value = { a: 1 };
        state.value = { a: 2 };
        state.value.a += 10;
      },
    });

    await scoped(s, () => go());
    expect(calls).toBe(1);
    expect(scoped(s, () => state.value.a)).toBe(12);
  });
});

describe("mutableStore — subscribers", () => {
  it("SUB-1: unsubscribe stops further notifications", () => {
    const state = mutableStore({ n: 0 });
    const s = scope();
    let calls = 0;
    const off = state.subscribe(() => calls++);
    scoped(s, () => (state.value.n = 1));
    off();
    scoped(s, () => (state.value.n = 2));
    expect(calls).toBe(1);
  });

  it("SUB-2: one shared subscriber fires for commits across two scopes with the right scope arg", () => {
    const state = mutableStore({ n: 0 });
    const x = scope();
    const y = scope();
    const seen: Array<[number, Scope]> = [];
    state.subscribe((v, sc) => seen.push([v.n, sc]));

    scoped(x, () => (state.value.n = 1));
    scoped(y, () => (state.value.n = 2));

    expect(seen).toEqual([
      [1, x],
      [2, y],
    ]);
  });

  it("SUB-3: a subscriber writing the store during notify produces a separate commit", () => {
    const state = mutableStore({ n: 0 });
    const s = scope();
    const seen: number[] = [];
    let guard = true;
    state.subscribe((v) => {
      seen.push(v.n);
      if (guard) {
        guard = false;
        scoped(s, () => (state.value.n += 100));
      }
    });

    scoped(s, () => (state.value.n = 1));
    expect(seen).toEqual([1, 101]);
    expect(scoped(s, () => state.value.n)).toBe(101);
  });

  it("SUB-3: a subscriber unsubscribing itself during notify is safe", () => {
    const state = mutableStore({ n: 0 });
    const s = scope();
    let aCalls = 0;
    let bCalls = 0;
    const offA = state.subscribe(() => {
      aCalls++;
      offA();
    });
    state.subscribe(() => bCalls++);

    expect(() => scoped(s, () => (state.value.n = 1))).not.toThrow();
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);

    scoped(s, () => (state.value.n = 2));
    expect(aCalls).toBe(1); // A removed itself
    expect(bCalls).toBe(2);
  });
});

describe("mutableStore — scope isolation", () => {
  it("ISO-1: a divergence in one scope is invisible to another; untouched default is shared", () => {
    const initial = { a: { v: 1 }, b: { v: 2 } };
    const state = mutableStore(initial);
    const x = scope();
    const y = scope();
    scoped(x, () => (state.value.a.v = 10));
    expect(scoped(y, () => state.value.a.v)).toBe(1);
    expect(scoped(x, () => unwrap(state.value.b))).toBe(initial.b);
    expect(scoped(y, () => unwrap(state.value.b))).toBe(initial.b);
  });

  it("ISO-2: a commit in scope x does not change a reader's value in scope y", async () => {
    const push = event<void>();
    const cart = mutableStore({ items: [] as number[] });
    const count = computed(() => cart.value.items.length);
    const x = scope();
    const y = scope();

    reaction({ on: push, run: () => void cart.value.items.push(1) });

    // Register the computed's deps in both scopes.
    expect(scoped(x, () => count.value)).toBe(0);
    expect(scoped(y, () => count.value)).toBe(0);

    await scoped(x, () => push());

    // x diverged; y still sees the untouched default (scope-parameterized run).
    expect(scoped(x, () => count.value)).toBe(1);
    expect(scoped(y, () => count.value)).toBe(0);
  });
});

describe("mutableStore — draft identity", () => {
  it("IDENT-1: draft proxies are recreated per COMMIT (transaction); unwrap stays stable once owned", () => {
    const state = mutableStore({ list: [] as number[] });
    const s = scope();
    scoped(s, () => state.value.list.push(1)); // diverge → owned
    const p1 = scoped(s, () => state.value.list);
    // A committing mutation tears down the draft; the next read builds a new proxy.
    // (Two consecutive *pure-read* scopes would reuse the same live draft/proxy —
    // it's the commit boundary, not the scoped() call, that recreates proxies.)
    scoped(s, () => state.value.list.push(2));
    const p2 = scoped(s, () => state.value.list);
    expect(p1).not.toBe(p2); // recreated after the commit
    expect(unwrap(p1)).toBe(unwrap(p2)); // owned → stable underlying identity
  });

  it("IDENT-2: reading the same path twice in one transaction returns the same proxy", () => {
    const state = mutableStore({ a: { x: 1 } });
    const s = scope();
    scoped(s, () => {
      const a1 = state.value.a;
      const a2 = state.value.a;
      expect(a1).toBe(a2); // childState cache hit while base unchanged
    });
  });

  it("IDENT-3: a child proxy cache is invalidated after its base changes", () => {
    const state = mutableStore({ a: { x: 1 } as { x: number } });
    const s = scope();
    scoped(s, () => {
      const a1 = state.value.a;
      state.value.a = { x: 9 };
      const a2 = state.value.a;
      expect(a1).not.toBe(a2);
      expect(unwrap(a2).x).toBe(9);
    });
  });
});

describe("mutableStore — seeding", () => {
  it("SEED-1: seed then mutate reflects the seeded base and notifies", () => {
    const state = mutableStore({ count: 0 });
    const s = scope();
    seedMutableStore(s, state, { count: 42 });
    let calls = 0;
    state.subscribe(() => calls++);
    scoped(s, () => state.value.count++);
    expect(scoped(s, () => state.value.count)).toBe(43);
    expect(calls).toBe(1);
  });

  it("SEED-2: seeding after a draft/base exists resets it", () => {
    const state = mutableStore({ a: 1 });
    const s = scope();
    scoped(s, () => (state.value.a = 1)); // establish a committed base
    seedMutableStore(s, state, { a: 100 });
    expect(scoped(s, () => state.value.a)).toBe(100);
  });

  it("SEED-3: seedMutableStore on a non-mutable store throws", () => {
    const s = scope();
    expect(() => seedMutableStore(s, {} as never, {} as never)).toThrow(
      /seedMutableStore: not a mutable store/,
    );
  });

  it("SEED-4: a seeded object is owned and mutated in place — visible on the caller's object", () => {
    const external = { count: 1 };
    const state = mutableStore({ count: 0 });
    const s = scope();
    seedMutableStore(s, state, external);
    scoped(s, () => (state.value.count = 5));
    expect(external.count).toBe(5); // owned → in place
  });
});

describe("mutableStore — unwrap & nested proxies", () => {
  it("UNWRAP-1: unwrap passes through primitives, null and plain non-draft objects", () => {
    const o = { k: 1 };
    expect(unwrap(5)).toBe(5);
    expect(unwrap(null)).toBe(null);
    expect(unwrap("x")).toBe("x");
    expect(unwrap(undefined)).toBe(undefined);
    expect(unwrap(o)).toBe(o);
  });

  it("UNWRAP-2: unwrap of a draft proxy returns its latest underlying object", () => {
    const state = mutableStore({ a: { x: 1 } });
    const s = scope();
    scoped(s, () => {
      const raw = unwrap(state.value.a);
      expect(raw).toEqual({ x: 1 });
      state.value.a.x = 2; // copy-on-write; raw was the pre-write base
      const raw2 = unwrap(state.value.a);
      expect(raw2.x).toBe(2);
    });
  });

  it("NESTED-PROXY: assigning one branch's proxy to another stores the raw object (no aliasing after divergence)", () => {
    const state = mutableStore({ a: { k: 1 }, b: null as null | { k: number } });
    const s = scope();
    scoped(s, () => (state.value.b = state.value.a)); // b gets unwrap(a)
    scoped(s, () => (state.value.b!.k = 9)); // COW copies b off the shared object
    scoped(s, () => {
      expect(state.value.a.k).toBe(1);
      expect(state.value.b!.k).toBe(9);
    });
  });
});

describe("mutableStore — map", () => {
  it("MAP-1/MAP-2: map is granular — an unrelated commit does not recompute it", async () => {
    const s = scope();
    const push = event<void>();
    const cart = mutableStore({ items: [] as number[], coupon: "" });
    const coupon = cart.map((v) => v.coupon);
    let runs = 0;
    reaction({ on: coupon, run: () => void runs++ });
    reaction({ on: push, run: () => void cart.value.items.push(1) });

    scoped(s, () => void coupon.value);
    runs = 0;

    await scoped(s, () => push());
    expect(runs).toBe(0); // map only read `coupon`
  });

  it("MAP: recomputes and reflects the new value when its read path changes", async () => {
    const s = scope();
    const setCoupon = event<void>();
    const cart = mutableStore({ coupon: "" });
    const coupon = cart.map((v) => v.coupon.toUpperCase());
    reaction({ on: setCoupon, run: () => void (cart.value.coupon = "sale") });

    expect(scoped(s, () => coupon.value)).toBe("");
    await scoped(s, () => setCoupon());
    expect(scoped(s, () => coupon.value)).toBe("SALE");
  });
});

describe("mutableStore — adversarial extras", () => {
  it("ARR-4 grow: arr.length = n grows the array with holes via the set trap", () => {
    const state = mutableStore({ items: [1, 2, 3] });
    const s = scope();
    scoped(s, () => {
      state.value.items.length = 5;
    });
    scoped(s, () => {
      expect(state.value.items.length).toBe(5);
      expect([...state.value.items]).toEqual([1, 2, 3, undefined, undefined]);
    });
  });

  it("ARR delete-index: `delete arr[i]` punches a hole, length unchanged, re-runs an index reader", async () => {
    const s = scope();
    const del = event<void>();
    const state = mutableStore({ items: [1, 2, 3] });
    const a1 = computed(() => state.value.items[1]);
    let runs = 0;
    reaction({ on: a1, run: () => void runs++ });
    reaction({ on: del, run: () => void delete state.value.items[1] });

    scoped(s, () => void a1.value);
    runs = 0;

    await scoped(s, () => del());
    expect(runs).toBe(1);
    scoped(s, () => {
      expect(state.value.items.length).toBe(3);
      expect(1 in state.value.items).toBe(false);
      expect(state.value.items[1]).toBeUndefined();
    });
  });

  it("SPREAD: a shallow-spread reader re-runs on an existing-key value change (get-based tracking)", async () => {
    const s = scope();
    const bump = event<void>();
    const state = mutableStore({ obj: { a: 1, b: 2 } as Record<string, number> });
    // Object spread reads each own enumerable value via [[Get]], so it tracks the
    // per-key paths — unlike a bare ownKeys/enumeration read.
    const shallow = computed(() => ({ ...state.value.obj }).a);
    let runs = 0;
    reaction({ on: shallow, run: () => void runs++ });
    reaction({ on: bump, run: () => void (state.value.obj.a = 5) });

    scoped(s, () => void shallow.value);
    runs = 0;

    await scoped(s, () => bump());
    expect(runs).toBe(1);
    expect(scoped(s, () => ({ ...state.value.obj }).a)).toBe(5);
  });

  it("DEEP-MAP: map over a nested path is granular to that path", async () => {
    const s = scope();
    const editX = event<void>();
    const editSibling = event<void>();
    const state = mutableStore({ a: { x: 0 }, b: { y: 0 } });
    const ax = state.map((v) => v.a.x);
    let runs = 0;
    reaction({ on: ax, run: () => void runs++ });
    reaction({ on: editSibling, run: () => void (state.value.b.y = 1) });
    reaction({ on: editX, run: () => void (state.value.a.x = 1) });

    scoped(s, () => void ax.value);
    runs = 0;

    await scoped(s, () => editSibling());
    expect(runs).toBe(0); // sibling untouched

    await scoped(s, () => editX());
    expect(runs).toBe(1);
    expect(scoped(s, () => ax.value)).toBe(1);
  });

  it("EMPTY: an empty-object store accepts a new key and enumerators react", async () => {
    const s = scope();
    const add = event<void>();
    const state = mutableStore({} as Record<string, number>);
    const keys = computed(() => Object.keys(state.value).length);
    let runs = 0;
    reaction({ on: keys, run: () => void runs++ });
    reaction({ on: add, run: () => void (state.value.fresh = 1) });

    scoped(s, () => void keys.value);
    runs = 0;

    await scoped(s, () => add());
    expect(runs).toBe(1);
    expect(scoped(s, () => state.value.fresh)).toBe(1);
    expect(scoped(s, () => Object.keys(state.value).length)).toBe(1);
  });

  it("DEEP-COW: mutating a nested array-of-objects copies only the touched chain", () => {
    const initial = { rows: [{ cells: [1, 2] }, { cells: [3, 4] }] };
    const snapshot = JSON.parse(JSON.stringify(initial));
    const state = mutableStore(initial);
    const s = scope();

    scoped(s, () => {
      state.value.rows[0].cells[1] = 99;
    });

    scoped(s, () => {
      expect(unwrap(state.value.rows)).not.toBe(initial.rows);
      expect(unwrap(state.value.rows[0])).not.toBe(initial.rows[0]);
      // Untouched sibling row stays shared by reference.
      expect(unwrap(state.value.rows[1])).toBe(initial.rows[1]);
      expect(state.value.rows[0].cells[1]).toBe(99);
    });
    // The shared base tree is byte-for-byte untouched.
    expect(initial).toEqual(snapshot);
  });

  it("SEED-ISO: seeding two scopes gives each its own owned base", () => {
    const state = mutableStore({ count: 0 });
    const x = scope();
    const y = scope();
    seedMutableStore(x, state, { count: 10 });
    seedMutableStore(y, state, { count: 20 });

    scoped(x, () => state.value.count++);

    expect(scoped(x, () => state.value.count)).toBe(11);
    expect(scoped(y, () => state.value.count)).toBe(20); // untouched by x
  });

  it("REENTRANT-BATCH: a mutation inside a batched reaction plus a subscriber write settles deterministically", async () => {
    const s = scope();
    const go = event<void>();
    const state = mutableStore({ n: 0 });
    const seen: number[] = [];
    let guard = true;
    state.subscribe((v) => {
      seen.push(v.n);
      if (guard) {
        guard = false;
        scoped(s, () => (state.value.n += 100));
      }
    });
    reaction({
      on: go,
      run() {
        state.value.n = 1;
        state.value.n = 2;
      },
    });

    await scoped(s, () => go());
    // The batched reaction commits once (n=2); the subscriber's reentrant write is
    // a separate commit (n=102). Ordering is deterministic.
    expect(seen).toEqual([2, 102]);
    expect(scoped(s, () => state.value.n)).toBe(102);
  });

  it("NULL-ASSIGN: assigning null clears a branch and reading it back is null (non-draftable)", () => {
    const state = mutableStore({ child: { k: 1 } as { k: number } | null });
    const s = scope();
    scoped(s, () => (state.value.child = null));
    scoped(s, () => {
      expect(state.value.child).toBeNull();
      expect(unwrap(state.value.child)).toBeNull();
    });
  });

  it("REPLACE-DEEP: replace then read a deep path opens a fresh draft over the new tree", () => {
    const state = mutableStore({ a: { b: { c: 1 } } });
    const s = scope();
    scoped(s, () => {
      state.value = { a: { b: { c: 42 } } };
      expect(state.value.a.b.c).toBe(42);
    });
    scoped(s, () => expect(state.value.a.b.c).toBe(42));
  });

  it("IDENT cross-scope: the same path yields different proxies in different scopes", () => {
    const state = mutableStore({ a: { x: 1 } });
    const x = scope();
    const y = scope();
    const px = scoped(x, () => state.value.a);
    const py = scoped(y, () => state.value.a);
    expect(px).not.toBe(py); // per-scope drafts
    // Both share the untouched base underneath.
    expect(unwrap(px)).toBe(unwrap(py));
  });
});

describe("mutableStore — type smoke checks", () => {
  it("TYPE-1/2/4: value is deeply mutable, map returns Store<U>, node/writable literal types", () => {
    const s = mutableStore({ user: { tags: ["x"] }, n: 0 });
    // Use the type-level form: `s.value` is a getter that throws without a scope.
    expectTypeOf<(typeof s)["value"]>().toEqualTypeOf<{ user: { tags: string[] }; n: number }>();
    const d = s.map((v) => v.n * 2);
    expectTypeOf(d).toMatchTypeOf<Store<number>>();
    expectTypeOf(s.node).toEqualTypeOf<Node>();
    expectTypeOf(s.writable).toEqualTypeOf<true>();
    // @ts-expect-error primitive initial is rejected (T extends object)
    mutableStore(5);
  });
});

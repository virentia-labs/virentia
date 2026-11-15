import { describe, expect, it } from "vitest";
import { scope, scoped, serialize, store, type Scope } from "../../lib";
import { f, model, staticModel } from "../../lib/models";
import { captureScopeSnapshot } from "../../lib/internal";
import { collection, stateOfCollection } from "../../lib/models/collection";

// A root registers model instances for snapshots only once a snapshot reader
// needs them. Whatever runs before that reader, the snapshot must match a root
// that registered every instance when it was created — key order included.

const Item = staticModel({
  name: "DeferredItem",
  data: { n: f.number(0), label: f.string("") },
});
const Flag = staticModel({ name: "DeferredFlag", data: { on: f.boolean(false).indexed() } });
const Draft = staticModel({
  name: "DeferredDraft",
  data: { n: f.number(0) },
  setup() {
    return { draft: store("", undefined, { sid: "draft" }) };
  },
});
const Dynamic = model({ name: "DeferredDynamic", data: { v: f.number(0) } });
const Seed = staticModel({ name: "DeferredSeed", data: { n: f.number(0) } });
const definitions = [Item, Flag, Dynamic, Draft] as const;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = { definition: (typeof definitions)[number]; instance: any };

/** Auto ids come from a global counter: name them by first appearance. */
function normalized(snapshot: object): string {
  const names = new Map<string, string>();
  return JSON.stringify(snapshot).replace(/~tmp\d+/g, (id) => {
    if (!names.has(id)) names.set(id, `~auto${names.size}`);
    return names.get(id)!;
  });
}

function run(seed: number, eager: boolean, steps: number, withDraft: boolean, withPlain: boolean) {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const app = scope();
  scoped(app, () => Seed.create({ id: "seed" }));
  // A snapshot reader registers everything from here on as it is created.
  if (eager) serialize(app);
  const rows: Row[] = [];
  // A dynamic instance keeps its namespace through rebind: reusing the old id collides.
  const dynamicIds = new Set<string>();
  const plain = store(0, undefined, { sid: "plain/value" });
  const results: string[] = [];
  const kinds = withDraft ? definitions : definitions.slice(0, 3);
  for (let step = 0; step < steps; step++) {
    const roll = random();
    if (roll < 0.35 || !rows.length) {
      const definition = pick(kinds);
      const supplied = random() < 0.7 ? { id: `r${Math.floor(random() * 12)}` } : {};
      if (
        supplied.id &&
        (rows.some((row) => row.definition === definition && row.instance.id === supplied.id) ||
          (definition === Dynamic && dynamicIds.has(supplied.id)))
      )
        continue;
      if (supplied.id && definition === Dynamic) dynamicIds.add(supplied.id);
      const instance = scoped(app, () => (definition as typeof Item).create(supplied as never));
      rows.push({ definition, instance });
    } else if (roll < 0.6) {
      const { definition, instance } = pick(rows);
      if (definition === Flag) instance.on.value = random() < 0.5;
      else if (definition === Dynamic) instance.v.value = Math.floor(random() * 100);
      else instance.n.value = Math.floor(random() * 100);
    } else if (roll < 0.72) {
      const row = pick(rows);
      const next = `r${Math.floor(random() * 12)}`;
      if (
        rows.some((other) => other.definition === row.definition && other.instance.id === next) ||
        (row.definition === Dynamic && dynamicIds.has(next))
      )
        continue;
      if (row.definition === Dynamic) dynamicIds.add(next);
      row.instance.rebind(next);
    } else if (roll < 0.86) {
      const row = pick(rows);
      rows.splice(rows.indexOf(row), 1);
      void row.instance.dispose();
    } else if (roll < 0.93) {
      const { definition, instance } = pick(rows);
      if (definition === Draft) instance.draft.value = `draft ${step}`;
      else if (definition === Item) instance.label.value = `label ${step}`;
    } else if (withPlain) {
      scoped(app, () => {
        plain.value = step;
      });
    }
    if (random() < 0.03) results.push(normalized(serialize(app)));
  }
  results.push(normalized(serialize(app)));
  return results;
}

describe("deferred model snapshot registration", () => {
  it.each([
    [1, false, false],
    [2, false, true],
    [3, true, false],
    [4, true, true],
    [5, false, false],
    [6, true, true],
  ])(
    "serializes exactly like eager registration (seed %i, draft %s, plain %s)",
    (seed, draft, plain) => {
      const eager = run(seed, true, 400, draft, plain);
      const deferred = run(seed, false, 400, draft, plain);
      expect(deferred).toEqual(eager);
    },
  );

  it("registers deferred instances in creation order across collections", () => {
    const app = scope();
    scoped(app, () => {
      Item.create({ id: "a", n: 1 });
      Flag.create({ id: "b", on: true });
      Item.create({ id: "c", n: 3 });
      Flag.create({ id: "d" });
    });
    const keys = Object.keys(serialize(app));
    const position = (id: string) => keys.findIndex((key) => key.includes(`:${id}/`));
    expect([position("a"), position("b"), position("c"), position("d")]).toEqual(
      [position("a"), position("b"), position("c"), position("d")].sort((x, y) => x - y),
    );
    expect(serialize(app).__virentia_model_instances__).toEqual({
      DeferredItem: [
        { id: "a", automatic: false, key: "instance:DeferredItem:a" },
        { id: "c", automatic: false, key: "instance:DeferredItem:c" },
      ],
      DeferredFlag: [
        { id: "b", automatic: false, key: "instance:DeferredFlag:b" },
        { id: "d", automatic: false, key: "instance:DeferredFlag:d" },
      ],
    });
  });

  it("keeps a rebound key and drops disposed rows when the first reader runs late", async () => {
    const app = scope();
    const [a, b] = scoped(app, () => [
      Item.create({ id: "a", n: 1 }),
      Item.create({ id: "b", n: 2 }),
    ]);
    a.rebind("renamed");
    await b.dispose();
    const fresh = scoped(app, () => Item.create({ id: "a", n: 5 }));
    const snapshot = serialize(app);
    expect(snapshot.__virentia_model_instances__).toEqual({
      DeferredItem: [
        { id: "renamed", automatic: false, key: "instance:DeferredItem:a" },
        { id: "a", automatic: false, key: "instance:DeferredItem:a" },
      ],
    });
    expect(Object.keys(snapshot).filter((key) => key.includes(":b/"))).toEqual([]);
    expect(fresh.n.value).toBe(5);
  });

  it("detects a same-named model, and a plain store in a model namespace, while deferring", () => {
    const First = staticModel({ name: "DeferredSame", data: { count: f.number(1) } });
    const Second = staticModel({ name: "DeferredSame", data: { count: f.number(2) } });
    const app = scope();
    scoped(app, () => First.create({ id: "row" }));
    expect(() => scoped(app, () => Second.create({ id: "row" }))).toThrow(/Duplicate store SID/);

    const Collision = staticModel({ name: "DeferredCollision", data: { count: f.number(0) } });
    const probe = scope();
    scoped(probe, () => Collision.create({ id: "row" }));
    const sid = Object.keys(serialize(probe)).find((key) => key.includes("/field:count"))!;
    const plain = store(5, undefined, { sid });
    const modelFirst = scope();
    scoped(modelFirst, () => Collision.create({ id: "row", count: 2 }));
    expect(() => scoped(modelFirst, () => plain.value)).toThrow(/Duplicate store SID/);
    const plainFirst = scope();
    scoped(plainFirst, () => plain.value);
    expect(() => scoped(plainFirst, () => Collision.create({ id: "row" }))).toThrow(
      /Duplicate store SID/,
    );
  });

  it("registers deferred instances before a read view copies the root", () => {
    const app = scope();
    const row = scoped(app, () => Item.create({ id: "row", n: 4 }));
    const view: Scope = captureScopeSnapshot(app);
    expect(serialize(view)).toEqual(serialize(app));
    row.n.value = 5;
    expect(Object.values(serialize(app))).toContain(5);
  });
});

describe("deferred registration around creation and rebind", () => {
  const InflightDraft = staticModel({
    name: "InflightDraft",
    data: { n: f.number(0) },
    setup() {
      return { draft: store("", undefined, { sid: "draft" }) };
    },
  });
  // A dynamic setup that touches an instance-owned SID store registers the root
  // while its own instance is still being created.
  const Editor = model({
    name: "InflightEditor",
    data: { t: f.string("") },
    setup() {
      const draft = InflightDraft.create({}) as any;
      draft.draft.value = "x";
      return { draft };
    },
  });
  const Tree: any = model({
    name: "DeferredTree",
    data: { depth: f.number(0) },
    setup(self: any) {
      if (self.depth.value < 2) Tree.create({ depth: self.depth.value + 1 });
      return {};
    },
  });

  function both(body: (app: Scope) => void): [string, string] {
    const results = [true, false].map((eager) => {
      const app = scope();
      scoped(app, () => Seed.create({ id: "seed" }));
      if (eager) serialize(app);
      body(app);
      return normalized(serialize(app));
    });
    return [results[1], results[0]];
  }

  it("registers an instance whose dynamic setup triggers the first reader", () => {
    const [deferred, eager] = both((app) => {
      scoped(app, () => InflightDraft.create({ id: "warm" }));
      scoped(app, () => Editor.create({ t: "a" }));
      scoped(app, () => Editor.create({ id: "e2", t: "b" }));
    });
    expect(deferred).toEqual(eager);
    expect(deferred).toContain("InflightEditor");
  });

  it("keeps allocation order for instances created inside a setup of the same model", () => {
    const [deferred, eager] = both((app) => {
      scoped(app, () => Tree.create({ depth: 0 }));
    });
    expect(deferred).toEqual(eager);
  });

  it("rejects a rebind onto an id another live instance holds, in both modes alike", () => {
    const [deferred, eager] = both((app) => {
      const [a] = scoped(app, () => [
        Item.create({ id: "a", n: 1 }),
        Item.create({ id: "b", n: 2 }),
      ]);
      expect(() => a.rebind("b")).toThrow('rebind(): id "b" is already taken');
      expect(a.id).toBe("a");
    });
    expect(deferred).toEqual(eager);
  });

  it("keeps a shared namespace at its first registrant's position", async () => {
    const [deferred, eager] = both((app) => {
      const x = scoped(app, () => Item.create({ id: "x", n: 1 }));
      scoped(app, () => Item.create({ id: "z", n: 2 }));
      x.rebind("y");
      scoped(app, () => Item.create({ id: "x", n: 3 }));
      void x.dispose();
    });
    expect(deferred).toEqual(eager);
  });
});

describe("deferred registration around failed and displacing creations", () => {
  const Fragile: any = model({
    name: "DeferredFragile",
    data: { fail: f.boolean(false) },
    setup(self: any) {
      if (self.fail.value) throw new Error("setup failed");
      return {};
    },
  });

  function both(body: (app: Scope) => void): [string, string] {
    const results = [true, false].map((eager) => {
      const app = scope();
      scoped(app, () => Seed.create({ id: "seed" }));
      if (eager) serialize(app);
      body(app);
      return normalized(serialize(app));
    });
    return [results[1], results[0]];
  }

  it("registers a creation whose setup threw, and keeps nothing for it", () => {
    let allocating: unknown[] | undefined;
    const [deferred, eager] = both((app) => {
      scoped(app, () => Fragile.create({ id: "ok" }));
      expect(() => scoped(app, () => Fragile.create({ id: "bad", fail: true }))).toThrow(
        "setup failed",
      );
      scoped(app, () => Fragile.create({}));
      allocating = stateOfCollection(scoped(app, () => collection(Fragile))).allocating;
    });
    expect(deferred).toEqual(eager);
    expect(allocating?.length ?? 0).toBe(0);
  });

  it("skips a generated id that a supplied one already took", () => {
    const ids: string[][] = [];
    const [deferred, eager] = both((app) => {
      // A supplied id equal to the next generated one: the generated
      // instance takes the id after it instead.
      const generated = scoped(app, () => Item.create({ n: 1 })) as { id: string };
      const next = `~tmp${Number(generated.id.slice(4)) + 1}`;
      const supplied = scoped(app, () => Item.create({ id: next, n: 2 })) as { id: string };
      const third = scoped(app, () => Item.create({ n: 3 })) as { id: string };
      expect(third.id).not.toBe(next);
      expect(scoped(app, () => collection(Item).get(next))).toBe(supplied);
      ids.push(scoped(app, () => Item.instances.ids));
    });
    expect(deferred).toEqual(eager);
    for (const list of ids) expect(new Set(list).size).toBe(list.length);
  });
});

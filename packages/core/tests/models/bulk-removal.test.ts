import { describe, expect, it } from "vitest";
import { computed, scope, scoped } from "../../lib";
import { f, refs, staticModel } from "../../lib/models";
import { collection, stateOfCollection } from "../../lib/models/collection";
import { instanceInternalOf } from "../../lib/models/definition";
import { sequenceBindingOf, type SequenceOperation } from "../../lib/sequence";

// A query removal of rows that run no user code updates the collection once.
// A no-op onCleanup keeps a row on the one-by-one path: both must agree on
// everything observable.

const Row = staticModel({
  name: "BulkRow",
  data: {
    rank: f.number(0).indexed(),
    score: f.number(0).indexed("ord"),
    label: f.string(""),
  },
});

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scenario(seed: number, withCleanups: boolean) {
  const random = mulberry32(seed);
  const app = scope();
  const rows = scoped(app, () =>
    Row.create(
      Array.from({ length: 60 }, (_, i) => ({
        id: `r${i}`,
        rank: Math.floor(random() * 4),
        score: Math.floor(random() * 10),
      })),
    ),
  );
  if (withCleanups) for (const row of rows) row.onCleanup(() => {});
  // Rebinds leave forwarding entries behind.
  for (let i = 0; i < 6; i++) rows[Math.floor(random() * rows.length)].rebind(`moved${i}`);
  const source = scoped(app, () => collection(Row));
  const events: string[] = [];
  const sequence = sequenceBindingOf<{ id: string }>(scoped(app, () => Row.instances))!;
  const stop = sequence.subscribe((operations: readonly SequenceOperation<{ id: string }>[]) => {
    for (const operation of operations)
      events.push(
        JSON.stringify(operation, (key, value) =>
          key === "items" ? (value as { id: string }[]).map((item) => item.id) : value,
        ),
      );
  });
  const counts = computed(() => [Row.instances.count, Row.where(Row.rank.eq(1)).count]);
  const seen: number[][] = [];
  const stopCounts = counts.subscribe((value) => seen.push(value));
  const observe = () =>
    scoped(app, () => ({
      ids: Row.instances.ids,
      rank: [0, 1, 2, 3].map((rank) => Row.where(Row.rank.eq(rank)).ids),
      sorted: Row.instances.sort(Row.score.asc).ids,
      top: Row.where(Row.score.gt(5)).ids,
      count: Row.instances.count,
      forwarding: [...stateOfCollection(source).aliases],
    }));
  const snapshots = [observe()];
  scoped(app, () => Row.where(Row.rank.eq(2)).remove());
  snapshots.push(observe());
  scoped(app, () => Row.where(Row.score.lt(3)).remove());
  snapshots.push(observe());
  // Creating after a removal reuses ids and recycled slots.
  scoped(app, () => Row.create({ id: "r1", rank: 1, score: 9 }));
  snapshots.push(observe());
  scoped(app, () => Row.instances.remove());
  snapshots.push(observe());
  scoped(app, () =>
    Row.create([
      { id: "r2", rank: 1 },
      { id: "again", rank: 3, score: 7 },
    ]),
  );
  snapshots.push(observe());
  stop();
  stopCounts();
  return { snapshots, events, seen, dead: rows.map((row) => row.alive) };
}

describe("bulk removal of leaf rows", () => {
  it.each([1, 2, 3, 4])("matches one-by-one disposal (seed %i)", (seed) => {
    expect(scenario(seed, false)).toEqual(scenario(seed, true));
  });

  it("disposes each row as settled and rejects further use", async () => {
    const app = scope();
    const rows = scoped(app, () => Row.create([{ id: "a" }, { id: "b" }]));
    scoped(app, () => Row.instances.remove());
    for (const row of rows) {
      expect(row.alive).toBe(false);
      expect(row.dispose()).toBeUndefined();
      expect(() => row.rank.value).toThrow(/entity was disposed/);
    }
  });

  it("keeps the one-by-one path when another model can reach the rows", () => {
    const Target: any = staticModel({ name: "BulkTarget", data: { n: f.number(0) } });
    const Holder: any = staticModel({
      name: "BulkHolder",
      data: { target: refs.one(Target, { policy: "restrict" }) },
    });
    const app = scope();
    const [first] = scoped(app, () => Target.create([{ id: "t1" }, { id: "t2" }]));
    scoped(app, () => Holder.create({ id: "h", target: first }));
    expect(() => scoped(app, () => Target.instances.remove())).toThrow(/restrict/);
    expect(scoped(app, () => Target.instances.count)).toBe(2);
  });
});

describe("instance membership flag", () => {
  it.each([7, 8, 9])(
    "mirrors the instance map through creations, rebinds and removals (seed %i)",
    (seed) => {
      const random = mulberry32(seed);
      const app = scope();
      const source = scoped(app, () => collection(Row));
      const state = stateOfCollection(source);
      const all: any[] = [];
      const check = () => {
        for (const row of all) {
          const internal = instanceInternalOf(row)!;
          expect(internal.listed === true).toBe(state.rows.get(internal.id) === internal);
        }
      };
      for (let step = 0; step < 300; step++) {
        const live = all.filter((row) => row.alive);
        const roll = random();
        if (roll < 0.4 || !live.length) {
          const supplied = random() < 0.5 ? { id: `id${Math.floor(random() * 8)}` } : {};
          all.push(scoped(app, () => Row.create(supplied)));
        } else if (roll < 0.7) {
          const row = live[Math.floor(random() * live.length)];
          const next = `id${Math.floor(random() * 8)}`;
          const holder = live.find((other) => other.id === next);
          if (holder && holder !== row) expect(() => row.rebind(next)).toThrow(/already taken/);
          else row.rebind(next);
        } else if (roll < 0.9) {
          void live[Math.floor(random() * live.length)].dispose();
        } else {
          scoped(app, () => Row.where(Row.rank.eq(0)).remove());
        }
        check();
      }
    },
  );
});

describe("bulk removal around unusual collections", () => {
  it("leaves the rows intact when a rebind onto a live id is rejected", () => {
    const outcome = (cleanups: boolean) => {
      const app = scope();
      const rows = scoped(app, () =>
        Row.create([
          { id: "a", rank: 0 },
          { id: "b", rank: 0 },
          { id: "c", rank: 1 },
        ]),
      );
      if (cleanups) for (const row of rows) row.onCleanup(() => {});
      expect(() => rows[0].rebind("b")).toThrow(/already taken/);
      const before = scoped(app, () => Row.instances.ids);
      scoped(app, () => Row.where(Row.rank.eq(0)).remove());
      const afterRank = scoped(app, () => Row.instances.ids);
      scoped(app, () => Row.instances.remove());
      return {
        before,
        afterRank,
        after: scoped(app, () => Row.instances.ids),
        alive: rows.map((row) => row.alive),
      };
    };
    expect(outcome(false)).toEqual({
      before: ["a", "b", "c"],
      afterRank: ["c"],
      after: [],
      alive: [false, false, false],
    });
    expect(outcome(true)).toEqual(outcome(false));
  });

  it("does not resolve refs targets nobody links to", () => {
    let resolved = 0;
    const Target: any = staticModel({ name: "LazyTarget", data: { n: f.number(0) } });
    const Holder: any = staticModel({
      name: "LazyHolder",
      data: {
        target: refs.one(() => {
          resolved++;
          return Target;
        }),
      },
    });
    const app = scope();
    scoped(app, () => Holder.create({ id: "h" }));
    scoped(app, () => Target.create([{ id: "t1" }, { id: "t2" }]));
    const before = resolved;
    scoped(app, () => Target.instances.remove());
    expect(resolved).toBe(before);
    expect(scoped(app, () => Target.instances.count)).toBe(0);
  });
});

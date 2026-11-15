import { afterEach, describe, expect, it } from "vitest";
import { allSettled, createStore } from "effector";
import { computed, effect, event, reaction, scoped } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { fool } from "../../lib";
import { callAssociation } from "../../lib/runtime";
import { makeAssociation, resetAmbientScope } from "../support/effector-harness";

afterEach(resetAmbientScope);

function counters() {
  const Counter = staticModel({
    data: { count: f.number(0) },
    setup(self) {
      const add = event<number>();
      reaction({ on: add, run(n) { self.count.value += n; } });
      return { add, doubled: computed(() => self.count.value * 2), save: effect<number, number>(async n => {
        self.count.value = n;
        return n * 2;
      }) };
    },
  });
  const first = makeAssociation(), second = makeAssociation();
  const [a, b] = scoped(first.v, () => [Counter.create({}), Counter.create({})]);
  const c = scoped(second.v, () => Counter.create({}));
  return { first, second, a, b, c, async dispose() {
    await a.dispose(); await b.dispose(); await c.dispose();
  } };
}

describe("static model units", () => {
  it("dispatches a bound event to one instance, without a model-wide broadcast", async () => {
    const h = counters();
    try {
      const add = fool(h.a.add);
      await allSettled(add, { scope: h.first.e, params: 3 });
      expect(h.a.count.value).toBe(3);
      expect(h.b.count.value).toBe(0);
      expect(h.c.count.value).toBe(0);
    } finally { await h.dispose(); }
  });

  it("routes an instance event back to the associated application", async () => {
    const h = counters();
    try {
      const $seen = createStore<number[]>([]).on(fool(h.a.add), (seen, n) => [...seen, n]);
      await h.a.add(2);
      await h.b.add(5);
      expect(h.first.e.getState($seen)).toEqual([2]);
      expect(h.second.e.getState($seen)).toEqual([]);
    } finally { await h.dispose(); }
  });

  it("observes a computed in its bound scope without evaluating self globally", async () => {
    const h = counters();
    try {
      const $seen = createStore<number[]>([]).on(fool(h.a.doubled), (seen, n) => [...seen, n]);
      await h.a.add(2);
      await h.b.add(5);
      expect(h.first.e.getState($seen)).toEqual([4]);
      expect(h.second.e.getState($seen)).toEqual([]);
    } finally { await h.dispose(); }
  });

  it("writes a bound data store in its instance rather than application scope", async () => {
    const h = counters();
    try {
      const changed = fool(h.a.count);
      await allSettled(changed, { scope: h.first.e, params: 7 });
      expect(h.a.count.value).toBe(7);
      expect(h.b.count.value).toBe(0);
      expect(h.c.count.value).toBe(0);
    } finally { await h.dispose(); }
  });

  it("rejects a model effect sent through another application's fork", async () => {
    const h = counters();
    try {
      const result = await allSettled(fool(h.a.save), { scope: h.second.e, params: 9 });
      expect(result.status).toBe("fail");
      expect([h.a.count.value, h.b.count.value, h.c.count.value]).toEqual([0, 0, 0]);
    } finally { await h.dispose(); }
  });

  it("rejects a bound store and event sent through another application", async () => {
    const h = counters();
    try {
      await expect(callAssociation(h.second.association, h.a.add, 4)).rejects.toThrow(/another associated application/);
      await expect(callAssociation(h.second.association, h.a.count, 4)).rejects.toThrow(/another associated application/);
      expect([h.a.count.value, h.b.count.value, h.c.count.value]).toEqual([0, 0, 0]);
    } finally { await h.dispose(); }
  });

  it("detaches a bound event bridge with its model lifetime", async () => {
    const h = counters();
    try {
      const source = h.a.add.node, original = source.next?.length ?? 0;
      fool(h.a.add);
      expect(source.next?.length).toBe(original + 1);
      await h.a.dispose();
      expect(source.next?.length ?? 0).toBe(original);
      await h.b.add(1);
      expect(h.b.count.value).toBe(1);
    } finally { await h.dispose(); }
  });
});

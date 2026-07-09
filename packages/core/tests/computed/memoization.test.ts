import { describe, expect, it } from "vitest";
import { computed, reaction, scope, scoped, store } from "../../lib";
import { run } from "../../lib/internal";
import { getScopedObservers } from "../../lib/kernel/scoped-edges";
import { readValue } from "../support/store-helpers";

describe("computed", () => {
  it("recomputes only after a dependency changes", () => {
    const sc = scope();
    const count = store(1);
    let calls = 0;
    const doubled = computed(() => {
      calls += 1;
      return count.value * 2;
    });

    scoped(sc, () => {
      expect(doubled.value).toBe(2);
      expect(doubled.value).toBe(2);
    });
    expect(calls).toBe(1);

    scoped(sc, () => {
      count.value = 3;
      expect(doubled.value).toBe(6);
    });
    expect(calls).toBe(2);
  });

  it("recomputes once despite repeated reads of a snapshot", () => {
    const sc = scope();
    const first = store("Ada");
    const last = store("Lovelace");
    let calls = 0;
    const label = computed(() => {
      calls += 1;
      return `${first.value} ${last.value}`;
    });

    scoped(sc, () => {
      expect(label.value).toBe("Ada Lovelace");
      expect(label.value).toBe("Ada Lovelace");
    });
    expect(calls).toBe(1);
  });

  it("exposes a field of an object snapshot", () => {
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

  describe("a per-scope cache", () => {
    it("isolates each scope's value", () => {
      const a = scope();
      const b = scope();
      const count = store(1);
      const doubled = computed(() => count.value * 2);

      scoped(a, () => {
        count.value = 2;
        expect(doubled.value).toBe(4);
      });
      scoped(b, () => {
        count.value = 5;
        expect(doubled.value).toBe(10);
      });
      expect(readValue(a, doubled)).toBe(4);
    });

    it("recomputes once per scope even on re-entry", () => {
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

    it("invalidates precisely per scope across three branches", async () => {
      const a = scope();
      const b = scope();
      const cc = scope();
      const pick = store(0); // 0->left, 1->mid, 2->right
      const left = store(1);
      const mid = store(10);
      const right = store(100);
      let computes = 0;
      const picked = computed(() => {
        computes += 1;
        const which = pick.value;
        return which === 0 ? left.value : which === 1 ? mid.value : right.value;
      });

      await run({ unit: pick.node, payload: 1, scope: b });
      await run({ unit: pick.node, payload: 2, scope: cc });

      expect(scoped(a, () => picked.value)).toBe(1);
      expect(scoped(b, () => picked.value)).toBe(10);
      expect(scoped(cc, () => picked.value)).toBe(100);

      const baseline = computes;

      // `left` changes in b (reads mid) and cc (reads right): no invalidation there.
      await run({ unit: left.node, payload: 2, scope: b });
      await run({ unit: left.node, payload: 3, scope: cc });
      expect(scoped(b, () => picked.value)).toBe(10);
      expect(scoped(cc, () => picked.value)).toBe(100);
      expect(computes).toBe(baseline);

      // `mid` changes in b (its selected branch): invalidates exactly there.
      await run({ unit: mid.node, payload: 11, scope: b });
      expect(scoped(b, () => picked.value)).toBe(11);
      expect(computes).toBe(baseline + 1);
    });
  });

  describe("when observed", () => {
    it("does not re-notify an equal recomputed value", () => {
      const sc = scope();
      const count = store(2);
      const parity = computed(() => count.value % 2);
      const seen: number[] = [];

      reaction({
        scope: sc,
        run: () => {
          seen.push(parity.value);
        },
      });

      scoped(sc, () => {
        count.value = 4; // same parity -> recomputes but equal -> no re-run
        count.value = 3; // parity flips -> re-run
      });

      expect(seen).toEqual([0, 1]);
    });

    it("re-runs a reaction on each changed value", () => {
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
  });

  describe("dependency partitioning", () => {
    it("excludes a map's static source from per-scope reconciliation", () => {
      const sc = scope();
      const s = store(1);
      const beforeNext = s.node.next?.length ?? 0;
      const d = s.map((v) => v * 2);
      const afterNext = s.node.next?.length ?? 0;

      // Creating the derived attaches a global invalidator edge to the source.
      expect(afterNext).toBe(beforeNext + 1);

      scoped(sc, () => {
        expect(d.value).toBe(2);
      });

      // The static source dep is excluded from per-scope reconciliation.
      expect(getScopedObservers(sc, s.node)?.size ?? 0).toBe(0);
    });

    it("records a dynamic read as a per-scope edge", () => {
      const sc = scope();
      const s = store(1);
      const c = computed(() => s.value * 2); // dynamic read, not a structural dep

      scoped(sc, () => {
        expect(c.value).toBe(2);
      });

      expect((getScopedObservers(sc, s.node)?.size ?? 0) > 0).toBe(true);
    });
  });
});

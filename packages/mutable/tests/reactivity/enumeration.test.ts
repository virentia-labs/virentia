import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped } from "@virentia/core";
import { mutableStore } from "../../lib";

describe("mutableStore", () => {
  describe("key enumeration", () => {
    it("re-runs an enumerator when a key is added but not when an existing key changes", async () => {
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

    it("fires the node path on a symbol-keyed set", async () => {
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

    it("re-runs an enumerator when a key is deleted but not for an absent key", async () => {
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

    it("re-runs an `in` reader when the probed key is added", async () => {
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

    it("leaves a getOwnPropertyDescriptor reader stale on a leaf value change", async () => {
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

    it("re-runs a shallow-spread reader on an existing-key value change", async () => {
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

    it("accepts a new key on an empty-object store and re-runs enumerators", async () => {
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

    // Reading `obj.a` reports the `obj` prefix as a dependency (a get walks
    // parent→child). Adding a NEW sibling key `obj.b` fires the `obj` node path
    // (shape change), so the `obj.a` reader re-runs even though `a` did not change.
    // Conservative over-notification, not a correctness defect — pinned so a future
    // refactor that changes it is noticed.
    it("re-runs an existing-key reader when a sibling key is added", async () => {
      const s = scope();
      const addKey = event<void>();
      const state = mutableStore({ obj: { a: 1 } as Record<string, number> });
      // Return a fresh object each eval (the RX-COARSE-2 trick) so the downstream
      // reaction fires on every RECOMPUTE — letting us observe whether the `obj.a`
      // reader is invalidated, independent of value equality.
      const aReader = computed(() => ({ v: state.value.obj.a }));
      let runs = 0;
      reaction({ on: aReader, run: () => void runs++ });
      reaction({ on: addKey, run: () => void (state.value.obj.b = 2) });

      scoped(s, () => void aReader.value);
      runs = 0;

      await scoped(s, () => addKey());
      // Descending root->obj reports the `obj` node path as a dep; adding a new key
      // fires that node path, so the `obj.a` reader is recomputed. Conservative
      // over-notification (value of a is unchanged), not a correctness defect.
      expect(runs).toBe(1);
      expect(scoped(s, () => state.value.obj.a)).toBe(1); // value unchanged
    });
  });
});

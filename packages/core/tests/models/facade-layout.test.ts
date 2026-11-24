import { describe, expect, it, vi } from "vitest";
import { computed, event, reaction, scope, scoped } from "../../lib";
import { modelInstanceBindingOf } from "../../lib/internal";
import { f, isModelInstance, model, staticModel } from "../../lib/models";

describe("model facade layout", () => {
  for (const define of [model, staticModel]) {
    it(`${define.name} probes customized prototype membership once and preserves reentrant handle identity`, () => {
      const Row = define({
        data: { count: f.number(1) },
        setup(self) {
          return { doubled: computed(() => self.count.value * 2) };
        },
      });
      const row = scoped(scope(), () => Row.create({ id: "reentrant" }));
      let nested: typeof row.doubled | undefined;
      let entering = false;
      let promote = false;
      let probes = 0;
      const prototype = new Proxy(
        {},
        {
          has(_target, key) {
            if (key === "doubled") {
              probes++;
              if (!entering) {
                entering = true;
                nested = row.doubled;
                if (promote) void row.count;
                entering = false;
              }
            }
            return false;
          },
        },
      );
      Object.setPrototypeOf(row, prototype);
      expect(row.doubled).toBe(nested);
      // One outer and one explicitly nested lookup, not a repeated API probe.
      expect(probes).toBe(2);
      probes = 0;
      expect(row.doubled).toBe(nested);
      expect(probes).toBe(2);
      promote = true;
      probes = 0;
      expect(row.doubled).toBe(nested);
      expect(probes).toBe(2);
      expect(row.doubled).toBe(nested);
      expect(row.doubled.value).toBe(2);
      row.dispose();
    });

    it(`${define.name} retains canonical identity after customization and respects accessor receivers`, async () => {
      const Row = define({ data: { count: f.number(2) } });
      const row = scoped(scope(), () => Row.create({ id: "original" }));
      Object.defineProperty(row, "id", {
        configurable: true,
        get() {
          expect(this).toBe(row);
          return `custom:${this.count.value}`;
        },
      });
      expect(row.id).toBe("custom:2");
      row.count.value = 3;
      expect(row.id).toBe("custom:3");
      expect(isModelInstance(new Proxy(row, {}))).toBe(false);
      expect(isModelInstance(row)).toBe(true);
      await row.dispose();
      expect(isModelInstance(row)).toBe(true);
      expect(isModelInstance(new Proxy(row, {}))).toBe(false);
    });

    it(`${define.name} promotes a single cached computed without replacing any handles`, async () => {
      const Row = define({
        data: { count: f.number(1) },
        setup(self) {
          const changed = event();
          reaction({
            on: changed,
            run() {
              self.count.value++;
            },
          });
          return { doubled: computed(() => self.count.value * 2), changed, empty: null, no: false };
        },
      });
      const row = scoped(scope(), () => Row.create({ id: "promoted" }));
      const doubled = row.doubled;
      expect(row.doubled).toBe(doubled);
      expect(doubled.value).toBe(2);
      expect([row.empty, row.no]).toEqual([null, false]);
      const field = row.count,
        changed = row.changed;
      expect(row.doubled).toBe(doubled);
      await changed();
      expect(row.count).toBe(field);
      expect(row.changed).toBe(changed);
      expect(doubled.value).toBe(4);
      Object.defineProperty(row, "doubled", { value: "own", configurable: true });
      expect(Reflect.get(row, "doubled")).toBe("own");
      Reflect.deleteProperty(row, "doubled");
      expect(row.doubled).toBe(doubled);
      await row.dispose();
    });

    it(`${define.name} preserves own API descriptors and detached methods`, async () => {
      const Row = define({ data: { count: f.number(0) } });
      const row = scoped(scope(), () => Row.create({ id: "row", count: 3 }));
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Object.keys(row)).toEqual([
        "id",
        "key",
        "alive",
        "json",
        "toJSON",
        "dispose",
        "onCleanup",
        "rebind",
      ]);
      expect(Object.hasOwn(row, "count")).toBe(false);
      expect("count" in row).toBe(true);
      const descriptor = Object.getOwnPropertyDescriptor(row, "id")!;
      expect(descriptor.get!()).toBe("row");
      expect(descriptor.enumerable).toBe(true);
      expect(descriptor.configurable).toBe(true);
      expect(Object.getOwnPropertyDescriptor(row, "id")!.get).toBe(descriptor.get);
      const { json, rebind, onCleanup, dispose } = row;
      const cleaned = vi.fn();
      onCleanup(cleaned);
      rebind("next");
      expect(json()).toEqual({ id: "next", count: 3 });
      expect(row.json).toBe(json);
      await dispose();
      expect(row.alive).toBe(false);
      expect(cleaned).toHaveBeenCalledTimes(1);
    });

    it(`${define.name} supports freeze without freezing the reactive model`, async () => {
      const Row = define({ data: { count: f.number(0) } });
      const row = scoped(scope(), () => Row.create({ id: "row" }));
      const binding = modelInstanceBindingOf(row);
      const frozen = Object.freeze(row);
      expect(frozen).toBe(row);
      expect(Object.isFrozen(row)).toBe(true);
      expect(modelInstanceBindingOf(row)).toBe(binding);
      row.count.value = 4;
      expect(row.json()).toEqual({ id: "row", count: 4 });
      const { dispose } = row;
      await dispose();
      expect(row.alive).toBe(false);
    });

    it(`${define.name} permits ordinary own-property mutation and prototype changes`, () => {
      const Row = define({ data: { count: f.number(0) } });
      const row = scoped(scope(), () => Row.create({ id: "row" }));
      Object.defineProperty(row, "extra", {
        value: "custom",
        enumerable: true,
        configurable: true,
      });
      expect(Object.keys(row).at(-1)).toBe("extra");
      expect(Reflect.deleteProperty(row, "extra")).toBe(true);
      const prototype = { inherited: 12 };
      Object.setPrototypeOf(row, prototype);
      expect(Object.getPrototypeOf(row)).toBe(prototype);
      expect(Reflect.get(row, "inherited")).toBe(12);
      expect(row.count.value).toBe(0);
      row.dispose();
    });

    it(`${define.name} keeps cached handles reactive and lets later explicit overrides win`, () => {
      const Row = define({
        data: { count: f.number(0) },
        setup() {
          return { zero: 0, no: false, empty: null };
        },
      });
      const row = scoped(scope(), () => Row.create({ id: "row" }));
      const count = row.count;
      expect([row.zero, row.no, row.empty]).toEqual([0, false, null]);
      expect([row.zero, row.no, row.empty]).toEqual([0, false, null]);
      row.count.value = 4;
      expect(row.count).toBe(count);
      expect(row.count.value).toBe(4);
      Object.defineProperty(row, "count", { value: "own", configurable: true });
      expect(Reflect.get(row, "count")).toBe("own");
      Reflect.deleteProperty(row, "count");
      Object.setPrototypeOf(row, { count: "inherited", zero: "overridden" });
      expect(Reflect.get(row, "count")).toBe("inherited");
      expect(Reflect.get(row, "zero")).toBe("overridden");
      Object.setPrototypeOf(row, Object.prototype);
      expect(row.count).toBe(count);
      expect(row.zero).toBe(0);
      row.dispose();
    });

    it(`${define.name} keeps reflected native identity live and honours an explicitly replaced accessor`, () => {
      const Row = define({ data: { count: f.number(0) } });
      const row = scoped(scope(), () => Row.create({ id: "before" }));
      const descriptor = Object.getOwnPropertyDescriptor(row, "id")!;
      row.rebind("after");
      expect(row.id).toBe("after");
      expect(descriptor.get!()).toBe("after");
      Object.defineProperty(row, "id", { get: () => "custom", configurable: true });
      expect(row.id).toBe("custom");
      expect(Object.getOwnPropertyDescriptor(row, "id")!.get!()).toBe("custom");
      row.dispose();
    });

    it(`${define.name} recognises only the canonical facade before and after disposal`, async () => {
      const Row = define({ data: { count: f.number(0) } });
      const row = scoped(scope(), () => Row.create({ id: "row" }));
      // Forwarding a private probe to a real facade must not brand the wrapper.
      const wrapper = new Proxy(row, {});
      expect(isModelInstance(wrapper)).toBe(false);
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      expect(isModelInstance(revoked.proxy)).toBe(false);
      expect(
        isModelInstance(
          new Proxy(
            {},
            {
              get() {
                throw Error("not a model");
              },
            },
          ),
        ),
      ).toBe(false);
      expect(isModelInstance(row)).toBe(true);
      expect(Object.getOwnPropertySymbols(row)).toHaveLength(1);
      await row.dispose();
      expect(isModelInstance(row)).toBe(true);
      expect(row.alive).toBe(false);
      expect(() => row.count.value).toThrow("disposed");
    });
  }
});

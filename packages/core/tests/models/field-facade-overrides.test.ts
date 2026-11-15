import { expect, it } from "vitest";
import { scope, scoped, type Scope } from "../../lib";
import {
  fixedStoreNodeOf,
  getActiveScope,
  modelInstanceBindingOf,
  type Node,
} from "../../lib/internal";
import { f, model, staticModel, type FieldStore } from "../../lib/models";

for (const define of [model, staticModel]) {
  it(`${define.name} honours a field store value override after its facade is cached`, () => {
    let source!: FieldStore<number>;
    const Row = define({
      data: { count: f.number(0) },
      setup(self) {
        source = self.count;
      },
    });
    const row = scoped(scope(), () => Row.create({ id: "row" }));
    const binding = modelInstanceBindingOf(row)!;
    const field = row.count;
    expect(field.value).toBe(0);
    let readScope: Scope | null = null;
    const prototype = Object.getPrototypeOf(source);
    Object.setPrototypeOf(source, {
      get value() {
        readScope = getActiveScope();
        return 17;
      },
    });
    expect(field.value).toBe(17);
    expect(row.json().count).toBe(17);
    expect(readScope).toBe(binding.scope);
    expect(scoped(binding.scope, () => field.value)).toBe(17);
    expect(fixedStoreNodeOf(field, binding.scope)).toBeUndefined();
    Object.setPrototypeOf(source, prototype);
    expect(field.value).toBe(0);
    expect(fixedStoreNodeOf(field, binding.scope)).toBe(source.node);
    row.dispose();
  });

  it(`${define.name} observes a live field scope resolver instead of a stale native read`, () => {
    let source!: FieldStore<number>;
    const Row = define({
      data: { count: f.number(0) },
      setup(self) {
        source = self.count;
      },
    });
    const row = scoped(scope(), () => Row.create({ id: "row" }));
    const binding = modelInstanceBindingOf(row)!;
    expect(row.count.value).toBe(0);
    const other = scope();
    scoped(other, () => {
      source.value = 9;
    });
    const sourceNode = source.node as Node;
    sourceNode.resolveScope = () => other;
    expect(row.count.value).toBe(9);
    expect(scoped(binding.scope, () => row.count.value)).toBe(9);
    expect(fixedStoreNodeOf(row.count, binding.scope)).toBeUndefined();
    row.count.value = 11;
    expect(scoped(other, () => source.value)).toBe(11);
    sourceNode.resolveScope = undefined;
    expect(row.count.value).toBe(0);
    row.dispose();
  });

  it(`${define.name} preserves customized native API write rejection and the caller frame`, () => {
    let source!: FieldStore<number>;
    const Row = define({
      data: { count: f.number(0) },
      setup(self) { source = self.count; },
    });
    const row = scoped(scope(), () => Row.create({ id: "row" }));
    const field = row.count;
    field.value = 2;
    const caller = scope();
    const prototype = Object.getPrototypeOf(source);
    // An inherited read-only `value` rejects the write.
    Object.setPrototypeOf(source, Object.freeze({ value: 9 }));
    scoped(caller, () => {
      expect(() => { field.value = 3; }).toThrow(TypeError);
      expect(getActiveScope()).toBe(caller);
    });
    Object.setPrototypeOf(source, prototype);
    expect(field.value).toBe(2);
    field.value = 4;
    expect(field.value).toBe(4);
    row.dispose();
  });

  it(`${define.name} writes through a proxied native API prototype without probing it`, () => {
    let source!: FieldStore<number>;
    const Row = define({ data: { count: f.number(0) }, setup(self) { source = self.count; } });
    const row = scoped(scope(), () => Row.create({ id: "row" }));
    const field = row.count, other = scope(), node = source.node as Node;
    const prototype = Object.getPrototypeOf(source);
    let probes = 0;
    Object.setPrototypeOf(source, new Proxy(prototype, {
      has(target, key) {
        if (key === "value") { probes++; node.resolveScope = () => other; }
        return Reflect.has(target, key);
      },
    }));
    field.value = 8;
    // A value store's write is a setter call: no membership probe, so the
    // write stays in the instance's own scope.
    expect(probes).toBe(0);
    Object.setPrototypeOf(source, prototype);
    node.resolveScope = undefined;
    expect(field.value).toBe(8);
    expect(scoped(other, () => source.value)).toBe(0);
    row.dispose();
  });
}

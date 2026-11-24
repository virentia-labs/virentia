import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped } from "../../lib";
import {
  directModelMemberOf,
  fixedStoreNodeOf,
  modelInstanceBindingOf,
  type ModelInstanceBinding,
} from "../../lib/internal";
import { instanceInternalOf } from "../../lib/models/definition";
import { f, model, staticModel } from "../../lib/models";

// What a compiled view binds for `self.model.<name>` (see `jsxMember` in
// @virentia/ui): the member read or called in place, as its facade would be.

function defineRow(define: typeof staticModel = staticModel) {
  return define({
    data: { label: f.string("") },
    setup(self) {
      const shout = computed(() => self.label.value.toUpperCase());
      const rename = event<string>();
      reaction({
        on: rename,
        run: (next) => {
          self.label.value = next;
        },
      });
      return { shout, rename, tag: "row", helper: () => self.label.value };
    },
  });
}

function binding(instance: object): ModelInstanceBinding {
  return modelInstanceBindingOf(instance)!;
}

describe("direct model members", () => {
  it("cover fields, store members and events, one for every instance", () => {
    const Row = defineRow();
    const app = scope();
    const [a, b] = scoped(app, () => [
      Row.create({ id: "a", label: "x" }),
      Row.create({ id: "b", label: "y" }),
    ]);
    const label = directModelMemberOf(binding(a), "label")!;
    const shout = directModelMemberOf(binding(a), "shout")!;
    const rename = directModelMemberOf(binding(a), "rename")!;
    expect([label.kind, shout.kind, rename.kind]).toEqual([0, 1, 2]);
    expect([label.name, shout.name, rename.name]).toEqual(["label", "shout", "rename"]);
    expect(directModelMemberOf(binding(b), "label")).toBe(label);
    expect(directModelMemberOf(binding(b), "shout")).toBe(shout);
    // Neither a value nor a plain function, nor what the proxy answers itself.
    for (const name of ["tag", "helper", "id", "then", "dispose", "missing"])
      expect(directModelMemberOf(binding(a), name)).toBeUndefined();
    // No facade was needed for any of that.
    expect(instanceInternalOf(a)!.facadeHandles).toBeUndefined();
  });

  it("read and call as the facade does, in the instance's scope and in another", async () => {
    const Row = defineRow();
    const app = scope();
    const other = scope();
    const a = scoped(app, () => Row.create({ id: "a", label: "x" }));
    const home = binding(a);
    const label = directModelMemberOf(home, "label")!;
    const shout = directModelMemberOf(home, "shout")!;
    const rename = directModelMemberOf(home, "rename")!;
    for (const where of [app, home.scope, other])
      scoped(where, () => {
        expect(label.read(home)).toBe("x");
        expect(shout.read(home)).toBe("X");
      });
    await scoped(other, () => rename.call(home, "z"));
    expect(a.label.value).toBe("z");
    scoped(app, () => expect([label.read(home), shout.read(home)]).toEqual(["z", "Z"]));
    expect(label.facade(home)).toBe(a.label);
    expect(rename.facade(home)).toBe(a.rename);
    expect(label.fixedNode(home, home.scope)).toBe(fixedStoreNodeOf(a.label, home.scope));
    expect(shout.fixedNode(home, home.scope)).toBe(fixedStoreNodeOf(a.shout, home.scope));
    expect(label.fixedNode(home, other)).toBeUndefined();
    expect(shout.fixedNode(home, other)).toBeUndefined();
    await a.dispose();
    const error = (read: () => unknown) => {
      try {
        read();
      } catch (caught) {
        return String(caught);
      }
      return "no error";
    };
    scoped(app, () => {
      expect(error(() => label.read(home))).toBe(error(() => a.label.value));
      expect(error(() => shout.read(home))).toBe(error(() => a.shout.value));
    });
    expect(error(() => rename.call(home, "late"))).toBe(error(() => a.rename("late")));
  });

  it("step aside for a property the instance defines itself", () => {
    const Row = defineRow();
    const a = scoped(scope(), () => Row.create({ id: "a", label: "x" }));
    expect(directModelMemberOf(binding(a), "label")).toBeDefined();
    Object.defineProperty(a, "label", { value: "own", configurable: true });
    expect(a.label as unknown).toBe("own");
    expect(directModelMemberOf(binding(a), "label")).toBeUndefined();
    expect(directModelMemberOf(binding(a), "shout")).toBeDefined();
  });

  it("are not offered for dynamic models and singletons", () => {
    const Dynamic = defineRow(model as typeof staticModel);
    const app = scope();
    const dynamic = scoped(app, () => Dynamic.create({ id: "a", label: "x" }));
    expect(directModelMemberOf(binding(dynamic), "label")).toBeUndefined();
    const singleton = defineRow().static();
    const singletonBinding = modelInstanceBindingOf(singleton);
    if (singletonBinding) expect(directModelMemberOf(singletonBinding, "label")).toBeUndefined();
    expect(directModelMemberOf({}, "label")).toBeUndefined();
  });
});

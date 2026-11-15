import { expect, it } from "vitest";
import { effect, scope, scoped } from "@virentia/core";
import { children, f, model, staticModel } from "@virentia/core/models";
import { createField, createForm } from "@virentia/forms";

it("creates dynamic graphs after native graphs and preserves mixed ownership and async scope", async () => {
  const first = scope(), second = scope(), cleanups: string[] = [];
  const Prelude = staticModel({ data: { count: f.number(0) } });
  const prelude = scoped(first, () => Prelude.create({ id: "prelude" }));
  expect(prelude.count.value).toBe(0);
  const tick = effect(async () => {});

  const DynamicChild = model({
    name: "MixedDynamicChild", data: { count: f.number(0) },
    setup(self) {
      self.onCleanup(() => cleanups.push("dynamic-child"));
      return { load: effect(async (value: number) => {
        await tick();
        self.count.value = value;
        return self.id;
      }) };
    },
  });
  const NativeChild = staticModel({
    name: "MixedNativeChild", data: { count: f.number(0) },
  });
  const NativeParent = staticModel({
    name: "MixedNativeParent", data: { child: children.one(DynamicChild) },
    onCreate(self) { self.child.create({ id: "dynamic-child" }); },
  });
  const DynamicParent = model({
    name: "MixedDynamicParent", data: { child: children.one(NativeChild) },
    onCreate(self) { self.child.create({ id: "native-child" }); },
  });
  const a = scoped(first, () => NativeParent.create({ id: "parent" }));
  const b = scoped(second, () => NativeParent.create({ id: "parent" }));
  const c = scoped(first, () => DynamicParent.create({ id: "parent" }));
  const d = scoped(second, () => DynamicParent.create({ id: "parent" }));
  const dynamicChild = a.child.value!, nativeChild = c.child.value!;
  try {
    expect(await dynamicChild.load(7)).toBe("dynamic-child");
    expect(dynamicChild.count.value).toBe(7);
    expect(b.child.value!.count.value).toBe(0);
    nativeChild.count.value = 9;
    expect(d.child.value!.count.value).toBe(0);
    expect(prelude.count.value).toBe(0);

    await a.dispose(); await c.dispose();
    expect(dynamicChild.alive).toBe(false);
    expect(nativeChild.alive).toBe(false);
    expect(cleanups).toEqual(["dynamic-child"]);
    expect(b.child.value!.alive).toBe(true);
    expect(d.child.value!.alive).toBe(true);

    const replacement = scoped(first, () => NativeParent.create({ id: "parent" }));
    try {
      expect(replacement.child.value!.count.value).toBe(0);
      expect(await replacement.child.value!.load(3)).toBe("dynamic-child");
      expect(replacement.child.value!.count.value).toBe(3);
      expect(b.child.value!.count.value).toBe(0);
    } finally { await replacement.dispose(); }
  } finally {
    await a.dispose(); await b.dispose(); await c.dispose(); await d.dispose(); await prelude.dispose();
  }
});

it("initializes form APIs returned by dynamic setups and releases them independently", async () => {
  const Editor = model({
    name: "DynamicFormInitialization",
    setup() {
      const field = createField("");
      return { field, form: createForm({ schema: { text: field } }) };
    },
  });
  const application = scope();
  const [first, second] = scoped(application, () => Editor.create([{ id: "first" }, { id: "second" }]));
  try {
    await first.field.fill("first");
    expect(first.form.values.value).toEqual({ text: "first" });
    expect(second.form.values.value).toEqual({ text: "" });
    await first.dispose();
    expect(first.alive).toBe(false);
    await second.field.fill("second");
    expect(second.form.values.value).toEqual({ text: "second" });
    const replacement = scoped(application, () => Editor.create({ id: "first" }));
    try {
      expect(replacement.form.values.value).toEqual({ text: "" });
      await replacement.form.fill({ values: { text: "replacement" } });
      expect(replacement.field.state.value).toBe("replacement");
      expect(second.field.state.value).toBe("second");
    } finally { await replacement.dispose(); }
  } finally { await first.dispose(); await second.dispose(); }
});

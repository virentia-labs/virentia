import { expect, it } from "vitest";
import { scope, scoped } from "../../lib";
import { modelInstanceBindingOf } from "../../lib/internal";
import { f, model, staticModel } from "../../lib/models";

it.each([model, staticModel])("keeps binding caches per instance and releases them on disposal (%s)", async (declare) => {
  const Row = declare({ data: { count: f.number(0) } });
  const left = scoped(scope(), () => Row.create({ id: "same" }));
  const right = scoped(scope(), () => Row.create({ id: "same" }));
  const a = modelInstanceBindingOf(left)!, b = modelInstanceBindingOf(right)!;
  const first = Symbol("first"), second = Symbol("second");
  const initial = { bindingKey: first }, replacement = { bindingKey: first }, other = { bindingKey: second };
  a.setData!(initial);
  expect(a.getData!(first)).toBe(initial);
  expect(b.getData!(first)).toBeUndefined();
  a.setData!(other);
  a.setData!(replacement);
  expect(a.getData!(first)).toBe(replacement);
  expect(a.getData!(second)).toBe(other);
  a.deleteData!(first);
  expect(a.getData!(first)).toBeUndefined();
  expect(a.getData!(second)).toBe(other);
  a.setData!(initial);
  await left.dispose();
  expect(a.getData!(first)).toBeUndefined();
  expect(a.getData!(second)).toBeUndefined();
  expect(right.alive).toBe(true);
  await right.dispose();
});

import { describe, expectTypeOf, it } from "vitest";
import type { DisposableOwner, Store } from "@virentia/core";
import type { ComponentModel } from "../../lib";

// ---------------------------------------------------------------------------
// ComponentModel & DisposableOwner brand
// ---------------------------------------------------------------------------
describe("ComponentModel", () => {
  it("keeps nested units RAW at depth (T7)", () => {
    type CM = ComponentModel<{ inner: { flag: Store<boolean> }; count: Store<number> }>;
    expectTypeOf<CM["inner"]["flag"]>().toEqualTypeOf<Store<boolean>>();
    expectTypeOf<CM["count"]>().toEqualTypeOf<Store<number>>();
  });

  it("is assignable to DisposableOwner (carries dispose + Symbol.dispose)", () => {
    type CM = ComponentModel<{ n: Store<number> }>;
    expectTypeOf<CM>().toMatchTypeOf<DisposableOwner>();
    expectTypeOf<CM["dispose"]>().toEqualTypeOf<() => void>();
    expectTypeOf<CM[typeof Symbol.dispose]>().toEqualTypeOf<() => void>();
  });

  it("preserves the model's own fields", () => {
    type CM = ComponentModel<{ n: Store<number>; label: string }>;
    expectTypeOf<CM["n"]>().toEqualTypeOf<Store<number>>();
    expectTypeOf<CM["label"]>().toEqualTypeOf<string>();
  });
});

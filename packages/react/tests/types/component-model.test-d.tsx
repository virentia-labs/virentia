import { describe, expectTypeOf, it } from "vitest";
import { store } from "@virentia/core";
import type { DisposableOwner, StoreWritable } from "@virentia/core";
import type {
  ComponentCreate,
  ComponentModel,
  ComponentPublicProps,
  VirentiaComponent,
} from "../../lib";

// ---------------------------------------------------------------------------
// ComponentModel<Model>
// ---------------------------------------------------------------------------

describe("ComponentModel", () => {
  type Model = { count: StoreWritable<number>; nested: { deep: { count: StoreWritable<number> } } };
  type CM = ComponentModel<Model>;

  it("keeps unit fields raw at depth", () => {
    expectTypeOf<CM["count"]>().toEqualTypeOf<StoreWritable<number>>();
    expectTypeOf<CM["nested"]["deep"]["count"]>().toEqualTypeOf<StoreWritable<number>>();
  });

  it("is assignable to the underlying Model and to DisposableOwner", () => {
    expectTypeOf<CM>().toMatchTypeOf<Model>();
    expectTypeOf<CM>().toMatchTypeOf<DisposableOwner>();
  });

  it("carries a nominal brand — a bare Model & DisposableOwner is NOT a ComponentModel", () => {
    expectTypeOf<Model & DisposableOwner>().not.toMatchTypeOf<CM>();
    expectTypeOf<Model>().not.toMatchTypeOf<CM>();
  });
});

// ---------------------------------------------------------------------------
// ComponentCreate / ComponentPublicProps / VirentiaComponent
// ---------------------------------------------------------------------------

describe("ComponentCreate", () => {
  type Create = ComponentCreate<{ a: number }, { count: StoreWritable<number> }>;

  it("takes Props and returns ComponentModel<Model>", () => {
    expectTypeOf<Create>().parameter(0).toEqualTypeOf<{ a: number }>();
    expectTypeOf<Create>().returns.toEqualTypeOf<ComponentModel<{ count: StoreWritable<number> }>>();
    expectTypeOf<Create>().toBeCallableWith({ a: 1 });
  });
});

describe("ComponentPublicProps", () => {
  type P = ComponentPublicProps<{ a: number; model: string }, { count: StoreWritable<number> }>;

  it("omits the incoming `model` prop and replaces it with an optional controlled ComponentModel", () => {
    expectTypeOf<P["a"]>().toEqualTypeOf<number>();
    expectTypeOf<P["model"]>().toEqualTypeOf<
      ComponentModel<{ count: StoreWritable<number> }> | undefined
    >();
  });
});

describe("VirentiaComponent", () => {
  type VCmp = VirentiaComponent<{ a: number }, { count: StoreWritable<number> }>;

  it("exposes a `create` factory equal to ComponentCreate", () => {
    expectTypeOf<VCmp["create"]>().toEqualTypeOf<
      ComponentCreate<{ a: number }, { count: StoreWritable<number> }>
    >();
    expectTypeOf<VCmp["create"]>().parameter(0).toEqualTypeOf<{ a: number }>();
    expectTypeOf<VCmp["create"]>().returns.toEqualTypeOf<
      ComponentModel<{ count: StoreWritable<number> }>
    >();
    expectTypeOf<VCmp["create"]>().toBeCallableWith({ a: 1 });
  });
});

// ---------------------------------------------------------------------------
// Overlapping subset originally in types.test.ts
// ---------------------------------------------------------------------------

describe("ComponentModel (runtime-value probes)", () => {
  // TODO(phase-2 dedup): overlaps "keeps unit fields raw at depth"
  it("keeps nested units raw at depth on the create() result", () => {
    const model = { count: store(0), nested: { deep: { count: store(0) } } };
    type CM = ComponentModel<typeof model>;
    expectTypeOf<CM["count"]>().toEqualTypeOf<StoreWritable<number>>();
    expectTypeOf<CM["nested"]["deep"]["count"]>().toEqualTypeOf<StoreWritable<number>>();
  });
});

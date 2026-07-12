import { describe, expectTypeOf, it } from "vitest";
import type { StoreWritable } from "@virentia/core";
import type { ComponentType } from "react";
import type { ModelCache, ModelFactory, ReactiveModel } from "../../lib";
import type { CachedComponentConfig, ComponentConfig } from "../../lib/types";

// ---------------------------------------------------------------------------
// ComponentConfig / CachedComponentConfig
// ---------------------------------------------------------------------------

describe("ComponentConfig", () => {
  type Cfg = ComponentConfig<{ a: number }, { count: StoreWritable<number> }>;

  it("pairs a ModelFactory with a view typed over the reactive model", () => {
    expectTypeOf<Cfg["model"]>().toEqualTypeOf<
      ModelFactory<{ a: number }, { count: StoreWritable<number> }>
    >();
    expectTypeOf<Cfg["view"]>().toEqualTypeOf<
      ComponentType<{ a: number } & { model: ReactiveModel<{ count: StoreWritable<number> }> }>
    >();
  });
});

describe("CachedComponentConfig", () => {
  type CCfg = CachedComponentConfig<{ a: number }, string, { count: StoreWritable<number> }>;

  it("adds a keyed cache that threads Key through the factory", () => {
    expectTypeOf<CCfg["key"]>().toEqualTypeOf<(props: { a: number }) => string>();
    expectTypeOf<CCfg["model"]>().toEqualTypeOf<
      ModelFactory<{ a: number }, { count: StoreWritable<number> }, string>
    >();
    expectTypeOf<CCfg["cache"]>().toEqualTypeOf<
      ModelCache<string, { a: number }, { count: StoreWritable<number> }>
    >();
    expectTypeOf<CCfg["view"]>().toEqualTypeOf<
      ComponentType<{ a: number } & { model: ReactiveModel<{ count: StoreWritable<number> }> }>
    >();
  });
});

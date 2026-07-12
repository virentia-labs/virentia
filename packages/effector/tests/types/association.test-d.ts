import { describe, expectTypeOf, it } from "vitest";
import type { Scope as EffectorScope } from "effector";
import type * as virentia from "@virentia/core";
import { associate, effectorAssociations, ensureAssociation } from "../../lib";
import type {
  EffectorAssociation,
  EffectorAssociationConfig,
  EffectorAssociationLookup,
  EffectorAssociations,
} from "../../lib";

declare const vScope: virentia.Scope;
declare const eScope: EffectorScope;

describe("associate()", () => {
  it("parameter is EffectorAssociationConfig, return is EffectorAssociation", () => {
    expectTypeOf(associate).parameter(0).toEqualTypeOf<EffectorAssociationConfig>();
    expectTypeOf(associate).returns.toEqualTypeOf<EffectorAssociation>();
    expectTypeOf(associate).toBeCallableWith({ virentia: vScope, effector: eScope });
  });

  it("both config fields are required", () => {
    // @ts-expect-error missing both required fields
    associate({});
    // @ts-expect-error missing effector
    associate({ virentia: vScope });
    // @ts-expect-error missing virentia
    associate({ effector: eScope });
  });
});

describe("ensureAssociation()", () => {
  it("returns a non-nullable EffectorAssociation", () => {
    expectTypeOf(ensureAssociation).returns.toEqualTypeOf<EffectorAssociation>();
    expectTypeOf(ensureAssociation).returns.not.toBeNever();
    expectTypeOf(ensureAssociation).returns.not.toBeNullable();
  });

  it("parameter is an optional EffectorAssociationLookup", () => {
    expectTypeOf(ensureAssociation)
      .parameter(0)
      .toEqualTypeOf<EffectorAssociationLookup | undefined>();
    expectTypeOf(ensureAssociation).toBeCallableWith();
    expectTypeOf(ensureAssociation).toBeCallableWith({});
    expectTypeOf(ensureAssociation).toBeCallableWith({ virentia: vScope });
    expectTypeOf(ensureAssociation).toBeCallableWith({ effector: eScope });
    expectTypeOf(ensureAssociation).toBeCallableWith({ virentia: vScope, effector: eScope });
  });

  it("rejects a non-lookup argument", () => {
    // @ts-expect-error number is not an EffectorAssociationLookup
    ensureAssociation(42);
  });
});

describe("effectorAssociations registry value", () => {
  it("matches the EffectorAssociations interface", () => {
    expectTypeOf(effectorAssociations).toEqualTypeOf<EffectorAssociations>();
  });

  it("byVirentia is a WeakMap keyed by virentia.Scope", () => {
    expectTypeOf(effectorAssociations.byVirentia).toEqualTypeOf<
      WeakMap<virentia.Scope, EffectorAssociation>
    >();
    expectTypeOf(effectorAssociations.byVirentia.get(vScope)).toEqualTypeOf<
      EffectorAssociation | undefined
    >();
  });

  it("byEffector is a WeakMap keyed by EffectorScope", () => {
    expectTypeOf(effectorAssociations.byEffector).toEqualTypeOf<
      WeakMap<EffectorScope, EffectorAssociation>
    >();
    expectTypeOf(effectorAssociations.byEffector.get(eScope)).toEqualTypeOf<
      EffectorAssociation | undefined
    >();
  });

  it("both map slots are readonly", () => {
    // @ts-expect-error byVirentia is a readonly property
    effectorAssociations.byVirentia = new WeakMap();
    // @ts-expect-error byEffector is a readonly property
    effectorAssociations.byEffector = new WeakMap();
  });
});

describe("exported association types", () => {
  it("EffectorAssociationConfig has two required scope fields", () => {
    expectTypeOf<EffectorAssociationConfig>().toEqualTypeOf<{
      virentia: virentia.Scope;
      effector: EffectorScope;
    }>();
  });

  it("EffectorAssociationLookup has two optional scope fields", () => {
    expectTypeOf<EffectorAssociationLookup>().toEqualTypeOf<{
      virentia?: virentia.Scope;
      effector?: EffectorScope;
    }>();
    // The empty object is a valid lookup.
    expectTypeOf<Record<string, never>>().toMatchTypeOf<EffectorAssociationLookup>();
  });

  it("EffectorAssociation exposes both scopes as readonly", () => {
    expectTypeOf<EffectorAssociation>().toEqualTypeOf<{
      readonly virentia: virentia.Scope;
      readonly effector: EffectorScope;
    }>();
    // Config (mutable) is assignable to the readonly association shape...
    expectTypeOf<EffectorAssociationConfig>().toMatchTypeOf<EffectorAssociation>();
    // ...but the readonly association is NOT structurally equal to the config.
    expectTypeOf<EffectorAssociation>().not.toEqualTypeOf<EffectorAssociationConfig>();
  });

  it("EffectorAssociations holds two readonly WeakMaps", () => {
    expectTypeOf<EffectorAssociations>().toEqualTypeOf<{
      readonly byVirentia: WeakMap<virentia.Scope, EffectorAssociation>;
      readonly byEffector: WeakMap<EffectorScope, EffectorAssociation>;
    }>();
  });
});

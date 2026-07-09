import { describe, expectTypeOf, it } from "vitest";
import type {
  Effect as EffectorEffect,
  EventCallable as EffectorEventCallable,
  Scope as EffectorScope,
  StoreWritable as EffectorStoreWritable,
  Unit as EffectorUnit,
  UnitTargetable as EffectorUnitTargetable,
} from "effector";
import type * as virentia from "@virentia/core";
import { associate, effectorAssociations, ensureAssociation, fool } from "../lib";
import type {
  EffectorAssociation,
  EffectorAssociationConfig,
  EffectorAssociationLookup,
  EffectorAssociations,
  VirentiaTarget,
  VirentiaUnit,
} from "../lib";
import { isEffectorUnit, isObjectLike, isVirentiaEffect, isVirentiaUnit } from "../lib/guards";
import type { BridgeTarget, BridgeUnit } from "../lib/internal-types";

// -------------------------------------------------------------------------
// Type-only probe. Its callback is type-checked by `tsc` but NEVER invoked at
// runtime, so `fool(...)` and friends are only ever evaluated at the type
// level — no real Effector/Virentia nodes are created, nothing can throw, and
// vitest runs each `it` as a no-op. Every `declare const` below is referenced
// solely from inside these callbacks, so there is never a runtime reference.
// -------------------------------------------------------------------------
function typecheck(_fn: () => void): void {}

// Virentia-side inputs, each with a precisely known static type so overload
// resolution is deterministic.
declare const vEvent: virentia.Event<number>;
declare const vEventCallable: virentia.EventCallable<number>;
declare const vEffect: virentia.Effect<number, string, boolean>;
declare const vStore: virentia.Store<number>;
declare const vStoreWritable: virentia.StoreWritable<number>;
declare const vEventVoid: virentia.EventCallable<void>;
declare const vEventUnion: virentia.EventCallable<number | string>;
declare const vEventReadonly: virentia.EventCallable<{ readonly id: string }>;
declare const vEventOptional: virentia.EventCallable<{ id?: string }>;
declare const vEventNested: virentia.EventCallable<Array<Map<string, number>>>;

// Effector-side inputs.
declare const eEventCallable: EffectorEventCallable<number>;
declare const eEffect: EffectorEffect<number, string, boolean>;
declare const eUnitTargetable: EffectorUnitTargetable<number>;
declare const eUnit: EffectorUnit<number>;
declare const eStoreWritable: EffectorStoreWritable<number>;

declare const vScope: virentia.Scope;
declare const eScope: EffectorScope;

// A value whose static type spans both bridge families at once.
declare const mixedFamily: virentia.EventCallable<number> | EffectorEventCallable<number>;

describe("fool() — virentia-direction overload return types (dual identity)", () => {
  it("virentia.EventCallable<T> -> EventCallable<T> & EffectorEventCallable<T>", () => {
    typecheck(() => {
      expectTypeOf(fool(vEventCallable)).toEqualTypeOf<
        virentia.EventCallable<number> & EffectorEventCallable<number>
      >();
    });
  });

  it("virentia.Event<T> (non-callable) -> Event<T> & EffectorEventCallable<T>", () => {
    typecheck(() => {
      expectTypeOf(fool(vEvent)).toEqualTypeOf<
        virentia.Event<number> & EffectorEventCallable<number>
      >();
    });
  });

  it("virentia.Effect<P,D,F> -> Effect<P,D,F> & EffectorEffect<P,D,F>", () => {
    typecheck(() => {
      expectTypeOf(fool(vEffect)).toEqualTypeOf<
        virentia.Effect<number, string, boolean> & EffectorEffect<number, string, boolean>
      >();
    });
  });

  it("virentia.StoreWritable<T> -> StoreWritable<T> & EffectorEventCallable<T>", () => {
    typecheck(() => {
      expectTypeOf(fool(vStoreWritable)).toEqualTypeOf<
        virentia.StoreWritable<number> & EffectorEventCallable<number>
      >();
    });
  });

  it("virentia.Store<T> (readonly) -> Store<T> & EffectorEventCallable<T>", () => {
    typecheck(() => {
      expectTypeOf(fool(vStore)).toEqualTypeOf<
        virentia.Store<number> & EffectorEventCallable<number>
      >();
    });
  });

  it("StoreWritable is NOT collapsed onto the readonly Store overload", () => {
    typecheck(() => {
      // If the writable overload were skipped this would fail (Store !== StoreWritable).
      expectTypeOf(fool(vStoreWritable)).not.toEqualTypeOf<
        virentia.Store<number> & EffectorEventCallable<number>
      >();
    });
  });
});

describe("fool() — effector-direction overload return types (mirror)", () => {
  it("EffectorEventCallable<T> -> EffectorEventCallable<T> & virentia.EventCallable<T>", () => {
    typecheck(() => {
      expectTypeOf(fool(eEventCallable)).toEqualTypeOf<
        EffectorEventCallable<number> & virentia.EventCallable<number>
      >();
    });
  });

  it("EffectorEffect<P,D,F> -> EffectorEffect<P,D,F> & virentia.Effect<P,D,F>", () => {
    typecheck(() => {
      expectTypeOf(fool(eEffect)).toEqualTypeOf<
        EffectorEffect<number, string, boolean> & virentia.Effect<number, string, boolean>
      >();
    });
  });

  it("EffectorUnitTargetable<T> -> EffectorUnitTargetable<T> & virentia.EventCallable<T>", () => {
    typecheck(() => {
      expectTypeOf(fool(eUnitTargetable)).toEqualTypeOf<
        EffectorUnitTargetable<number> & virentia.EventCallable<number>
      >();
    });
  });

  it("EffectorUnit<T> -> EffectorUnit<T> & virentia.EventCallable<T>", () => {
    typecheck(() => {
      expectTypeOf(fool(eUnit)).toEqualTypeOf<
        EffectorUnit<number> & virentia.EventCallable<number>
      >();
    });
  });

  it("EffectorStoreWritable<T> resolves via the UnitTargetable overload", () => {
    typecheck(() => {
      // A writable effector store extends UnitTargetable but not EventCallable,
      // so it matches the UnitTargetable overload — NOT a store-specific one
      // (there is none on the effector side).
      expectTypeOf(fool(eStoreWritable)).toEqualTypeOf<
        EffectorUnitTargetable<number> & virentia.EventCallable<number>
      >();
    });
  });

  it("TYPE/RUNTIME DIVERGENCE: fooling an effector Store drops its Store surface", () => {
    typecheck(() => {
      // BUG: there is no `EffectorStore`/`EffectorStoreWritable` fool() overload,
      // so a fooled effector store is statically typed as UnitTargetable &
      // EventCallable and loses `updates`, `reinit`, `.kind === "store"`, etc.,
      // even though `copyUnitProperties` keeps them on the runtime object.
      const fooled = fool(eStoreWritable);
      // @ts-expect-error `updates` exists at runtime but is erased from the type
      void fooled.updates;
      // @ts-expect-error `reinit` exists at runtime but is erased from the type
      void fooled.reinit;
    });
  });

  it("effect intersection is order-independent between the two directions", () => {
    typecheck(() => {
      expectTypeOf(fool(eEffect)).toEqualTypeOf<
        virentia.Effect<number, string, boolean> & EffectorEffect<number, string, boolean>
      >();
    });
  });
});

describe("fool() — payload edge cases (void / union / readonly / optional / nested)", () => {
  it("void payload keeps void through the intersection", () => {
    typecheck(() => {
      expectTypeOf(fool(vEventVoid)).toEqualTypeOf<
        virentia.EventCallable<void> & EffectorEventCallable<void>
      >();
    });
  });

  it("union payload does NOT distribute the intersection over the union", () => {
    typecheck(() => {
      // Correct: a single unit carrying `number | string`.
      expectTypeOf(fool(vEventUnion)).toEqualTypeOf<
        virentia.EventCallable<number | string> & EffectorEventCallable<number | string>
      >();
      // Wrong (distributed) shape must NOT be what we get.
      expectTypeOf(fool(vEventUnion)).not.toEqualTypeOf<
        | (virentia.EventCallable<number> & EffectorEventCallable<number>)
        | (virentia.EventCallable<string> & EffectorEventCallable<string>)
      >();
    });
  });

  it("readonly members of the payload are preserved", () => {
    typecheck(() => {
      expectTypeOf(fool(vEventReadonly)).toEqualTypeOf<
        virentia.EventCallable<{ readonly id: string }> &
          EffectorEventCallable<{ readonly id: string }>
      >();
    });
  });

  it("optional members of the payload are preserved", () => {
    typecheck(() => {
      expectTypeOf(fool(vEventOptional)).toEqualTypeOf<
        virentia.EventCallable<{ id?: string }> & EffectorEventCallable<{ id?: string }>
      >();
    });
  });

  it("nested generics survive the intersection", () => {
    typecheck(() => {
      expectTypeOf(fool(vEventNested)).toEqualTypeOf<
        virentia.EventCallable<Array<Map<string, number>>> &
          EffectorEventCallable<Array<Map<string, number>>>
      >();
    });
  });
});

describe("fool() — dual-identity usability of the returned unit", () => {
  it("a fooled virentia event exposes both Effector and Virentia surface", () => {
    typecheck(() => {
      const fooled = fool(vEventCallable);
      // Effector surface.
      expectTypeOf(fooled).toHaveProperty("kind");
      expectTypeOf(fooled).toHaveProperty("watch");
      expectTypeOf(fooled).toHaveProperty("subscribe");
      // Virentia surface.
      expectTypeOf(fooled).toHaveProperty("node");
      expectTypeOf(fooled).toHaveProperty("map");
      expectTypeOf(fooled).toHaveProperty("filter");
      // Callable from the caller's perspective.
      expectTypeOf(fooled).toBeCallableWith(5);
    });
  });

  it("a fooled effector event is usable on both sides too", () => {
    typecheck(() => {
      const fooled = fool(eEventCallable);
      expectTypeOf(fooled).toHaveProperty("kind");
      expectTypeOf(fooled).toHaveProperty("node");
      expectTypeOf(fooled).toHaveProperty("map");
      expectTypeOf(fooled).toBeCallableWith(5);
    });
  });

  it("a fooled effect keeps its done/fail projections and pending store", () => {
    typecheck(() => {
      const fooled = fool(vEffect);
      expectTypeOf(fooled).toHaveProperty("done");
      expectTypeOf(fooled).toHaveProperty("fail");
      expectTypeOf(fooled).toHaveProperty("pending");
      expectTypeOf(fooled).toHaveProperty("kind");
      expectTypeOf(fooled).toBeCallableWith(5);
    });
  });

  it("a fooled non-callable virentia Event becomes callable via the effector side", () => {
    typecheck(() => {
      // The input `virentia.Event<number>` is NOT callable on its own.
      expectTypeOf(vEvent).not.toBeFunction();
      // After fooling, the EffectorEventCallable intersection makes it callable.
      expectTypeOf(fool(vEvent)).toBeCallableWith(5);
    });
  });
});

describe("fool() — negative cases (must be compile errors)", () => {
  it("rejects primitives and non-units", () => {
    typecheck(() => {
      // @ts-expect-error number is not a bridgeable unit
      fool(42);
      // @ts-expect-error string is not a bridgeable unit
      fool("nope");
      // @ts-expect-error null is not a bridgeable unit
      fool(null);
      // @ts-expect-error plain object is not a bridgeable unit
      fool({ foo: 1 });
    });
  });

  it("rejects a union spanning both bridge families (no single overload matches)", () => {
    typecheck(() => {
      // @ts-expect-error overloads cannot accept an already-merged cross-family union
      fool(mixedFamily);
    });
  });
});

describe("associate()", () => {
  it("parameter is EffectorAssociationConfig, return is EffectorAssociation", () => {
    typecheck(() => {
      expectTypeOf(associate).parameter(0).toEqualTypeOf<EffectorAssociationConfig>();
      expectTypeOf(associate).returns.toEqualTypeOf<EffectorAssociation>();
      expectTypeOf(associate).toBeCallableWith({ virentia: vScope, effector: eScope });
    });
  });

  it("both config fields are required", () => {
    typecheck(() => {
      // @ts-expect-error missing both required fields
      associate({});
      // @ts-expect-error missing effector
      associate({ virentia: vScope });
      // @ts-expect-error missing virentia
      associate({ effector: eScope });
    });
  });
});

describe("ensureAssociation()", () => {
  it("returns a non-nullable EffectorAssociation", () => {
    typecheck(() => {
      expectTypeOf(ensureAssociation).returns.toEqualTypeOf<EffectorAssociation>();
      expectTypeOf(ensureAssociation).returns.not.toBeNever();
      expectTypeOf(ensureAssociation).returns.not.toBeNullable();
    });
  });

  it("parameter is an optional EffectorAssociationLookup", () => {
    typecheck(() => {
      expectTypeOf(ensureAssociation)
        .parameter(0)
        .toEqualTypeOf<EffectorAssociationLookup | undefined>();
      expectTypeOf(ensureAssociation).toBeCallableWith();
      expectTypeOf(ensureAssociation).toBeCallableWith({});
      expectTypeOf(ensureAssociation).toBeCallableWith({ virentia: vScope });
      expectTypeOf(ensureAssociation).toBeCallableWith({ effector: eScope });
      expectTypeOf(ensureAssociation).toBeCallableWith({ virentia: vScope, effector: eScope });
    });
  });

  it("rejects a non-lookup argument", () => {
    typecheck(() => {
      // @ts-expect-error number is not an EffectorAssociationLookup
      ensureAssociation(42);
    });
  });
});

describe("effectorAssociations registry value", () => {
  it("matches the EffectorAssociations interface", () => {
    typecheck(() => {
      expectTypeOf(effectorAssociations).toEqualTypeOf<EffectorAssociations>();
    });
  });

  it("byVirentia is a WeakMap keyed by virentia.Scope", () => {
    typecheck(() => {
      expectTypeOf(effectorAssociations.byVirentia).toEqualTypeOf<
        WeakMap<virentia.Scope, EffectorAssociation>
      >();
      expectTypeOf(effectorAssociations.byVirentia.get(vScope)).toEqualTypeOf<
        EffectorAssociation | undefined
      >();
    });
  });

  it("byEffector is a WeakMap keyed by EffectorScope", () => {
    typecheck(() => {
      expectTypeOf(effectorAssociations.byEffector).toEqualTypeOf<
        WeakMap<EffectorScope, EffectorAssociation>
      >();
      expectTypeOf(effectorAssociations.byEffector.get(eScope)).toEqualTypeOf<
        EffectorAssociation | undefined
      >();
    });
  });

  it("both map slots are readonly", () => {
    typecheck(() => {
      // @ts-expect-error byVirentia is a readonly property
      effectorAssociations.byVirentia = new WeakMap();
      // @ts-expect-error byEffector is a readonly property
      effectorAssociations.byEffector = new WeakMap();
    });
  });
});

describe("exported association types", () => {
  it("EffectorAssociationConfig has two required scope fields", () => {
    typecheck(() => {
      expectTypeOf<EffectorAssociationConfig>().toEqualTypeOf<{
        virentia: virentia.Scope;
        effector: EffectorScope;
      }>();
    });
  });

  it("EffectorAssociationLookup has two optional scope fields", () => {
    typecheck(() => {
      expectTypeOf<EffectorAssociationLookup>().toEqualTypeOf<{
        virentia?: virentia.Scope;
        effector?: EffectorScope;
      }>();
      // The empty object is a valid lookup.
      expectTypeOf<Record<string, never>>().toMatchTypeOf<EffectorAssociationLookup>();
    });
  });

  it("EffectorAssociation exposes both scopes as readonly", () => {
    typecheck(() => {
      expectTypeOf<EffectorAssociation>().toEqualTypeOf<{
        readonly virentia: virentia.Scope;
        readonly effector: EffectorScope;
      }>();
      // Config (mutable) is assignable to the readonly association shape...
      expectTypeOf<EffectorAssociationConfig>().toMatchTypeOf<EffectorAssociation>();
      // ...but the readonly association is NOT structurally equal to the config.
      expectTypeOf<EffectorAssociation>().not.toEqualTypeOf<EffectorAssociationConfig>();
    });
  });

  it("EffectorAssociations holds two readonly WeakMaps", () => {
    typecheck(() => {
      expectTypeOf<EffectorAssociations>().toEqualTypeOf<{
        readonly byVirentia: WeakMap<virentia.Scope, EffectorAssociation>;
        readonly byEffector: WeakMap<EffectorScope, EffectorAssociation>;
      }>();
    });
  });
});

describe("VirentiaUnit / VirentiaTarget", () => {
  it("VirentiaUnit<T> is the five-member virentia unit union", () => {
    typecheck(() => {
      expectTypeOf<VirentiaUnit<number>>().toEqualTypeOf<
        | virentia.Event<number>
        | virentia.EventCallable<number>
        | virentia.Effect<number, any, any>
        | virentia.Store<number>
        | virentia.StoreWritable<number>
      >();
    });
  });

  it("VirentiaUnit default parameter is unknown", () => {
    typecheck(() => {
      expectTypeOf<VirentiaUnit>().toEqualTypeOf<VirentiaUnit<unknown>>();
    });
  });

  it("VirentiaTarget<T> is the three writable/callable targets", () => {
    typecheck(() => {
      expectTypeOf<VirentiaTarget<number>>().toEqualTypeOf<
        | virentia.EventCallable<number>
        | virentia.Effect<number, any, any>
        | virentia.StoreWritable<number>
      >();
    });
  });

  it("VirentiaTarget default parameter is unknown", () => {
    typecheck(() => {
      expectTypeOf<VirentiaTarget>().toEqualTypeOf<VirentiaTarget<unknown>>();
    });
  });

  it("no member of the union collapses to `any` or leaks `never`", () => {
    typecheck(() => {
      expectTypeOf<VirentiaUnit<number>>().not.toBeAny();
      expectTypeOf<VirentiaUnit<number>>().not.toBeNever();
      expectTypeOf<VirentiaUnit<any>>().not.toBeAny();
      expectTypeOf<VirentiaUnit<any>>().not.toBeNever();
      expectTypeOf<VirentiaTarget<never>>().not.toBeNever();
    });
  });

  it("every VirentiaTarget is a VirentiaUnit but not vice-versa", () => {
    typecheck(() => {
      expectTypeOf<VirentiaTarget<number>>().toMatchTypeOf<VirentiaUnit<number>>();
      expectTypeOf<VirentiaUnit<number>>().not.toMatchTypeOf<VirentiaTarget<number>>();
    });
  });
});

describe("internal bridge types (BridgeUnit / BridgeTarget)", () => {
  it("BridgeUnit<T> unions the effector and virentia unit worlds", () => {
    typecheck(() => {
      expectTypeOf<BridgeUnit<number>>().toEqualTypeOf<
        EffectorUnit<number> | EffectorUnitTargetable<number> | VirentiaUnit<number>
      >();
    });
  });

  it("BridgeTarget<T> unions the effector and virentia target worlds", () => {
    typecheck(() => {
      expectTypeOf<BridgeTarget<number>>().toEqualTypeOf<
        EffectorUnitTargetable<number> | VirentiaTarget<number>
      >();
    });
  });

  it("BridgeUnit default parameter is any, BridgeTarget default is unknown", () => {
    typecheck(() => {
      expectTypeOf<BridgeUnit>().toEqualTypeOf<BridgeUnit<any>>();
      expectTypeOf<BridgeTarget>().toEqualTypeOf<BridgeTarget<unknown>>();
      // Whole-union defaults must not collapse to `any` or `never`.
      expectTypeOf<BridgeUnit>().not.toBeAny();
      expectTypeOf<BridgeUnit>().not.toBeNever();
      expectTypeOf<BridgeTarget>().not.toBeNever();
    });
  });
});

describe("guards — `is`-narrowing return types", () => {
  it("isEffectorUnit narrows unknown -> EffectorUnit<any>", () => {
    typecheck(() => {
      expectTypeOf(isEffectorUnit).guards.toEqualTypeOf<EffectorUnit<any>>();
      expectTypeOf(isEffectorUnit).parameter(0).toEqualTypeOf<unknown>();
      const value: unknown = undefined;
      if (isEffectorUnit(value)) {
        expectTypeOf(value).toEqualTypeOf<EffectorUnit<any>>();
      }
    });
  });

  it("isVirentiaUnit narrows unknown -> VirentiaUnit<any>", () => {
    typecheck(() => {
      expectTypeOf(isVirentiaUnit).guards.toEqualTypeOf<VirentiaUnit<any>>();
      const value: unknown = undefined;
      if (isVirentiaUnit(value)) {
        expectTypeOf(value).toEqualTypeOf<VirentiaUnit<any>>();
      }
    });
  });

  it("isVirentiaEffect narrows unknown -> virentia.Effect<any, any, any>", () => {
    typecheck(() => {
      expectTypeOf(isVirentiaEffect).guards.toEqualTypeOf<virentia.Effect<any, any, any>>();
      const value: unknown = undefined;
      if (isVirentiaEffect(value)) {
        expectTypeOf(value).toEqualTypeOf<virentia.Effect<any, any, any>>();
        // narrowed guard is a proper VirentiaUnit member
        expectTypeOf(value).toMatchTypeOf<VirentiaUnit<any>>();
      }
    });
  });

  it("isObjectLike narrows unknown -> object", () => {
    typecheck(() => {
      expectTypeOf(isObjectLike).guards.toEqualTypeOf<object>();
      const value: unknown = undefined;
      if (isObjectLike(value)) {
        expectTypeOf(value).toEqualTypeOf<object>();
      }
    });
  });

  it("guard predicates are none-narrowing to never on the true branch", () => {
    typecheck(() => {
      expectTypeOf(isEffectorUnit).guards.not.toBeNever();
      expectTypeOf(isVirentiaUnit).guards.not.toBeNever();
      expectTypeOf(isVirentiaEffect).guards.not.toBeNever();
      expectTypeOf(isObjectLike).guards.not.toBeNever();
    });
  });
});

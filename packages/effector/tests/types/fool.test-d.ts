import { describe, expectTypeOf, it } from "vitest";
import { createEvent } from "effector";
import type {
  Effect as EffectorEffect,
  EventCallable as EffectorEventCallable,
  StoreWritable as EffectorStoreWritable,
  Unit as EffectorUnit,
  UnitTargetable as EffectorUnitTargetable,
} from "effector";
import { effect, event } from "@virentia/core";
import type * as virentia from "@virentia/core";
import type { Effect as VirentiaEffect, EventCallable as VirentiaEventCallable } from "@virentia/core";
import { fool } from "../../lib";

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

// A value whose static type spans both bridge families at once.
declare const mixedFamily: virentia.EventCallable<number> | EffectorEventCallable<number>;

describe("fool() — virentia-direction overload return types (dual identity)", () => {
  it("virentia.EventCallable<T> -> EventCallable<T> & EffectorEventCallable<T>", () => {
    expectTypeOf(fool(vEventCallable)).toEqualTypeOf<
      virentia.EventCallable<number> & EffectorEventCallable<number>
    >();
  });

  it("virentia.Event<T> (non-callable) -> Event<T> & EffectorEventCallable<T>", () => {
    expectTypeOf(fool(vEvent)).toEqualTypeOf<
      virentia.Event<number> & EffectorEventCallable<number>
    >();
  });

  it("virentia.Effect<P,D,F> -> Effect<P,D,F> & EffectorEffect<P,D,F>", () => {
    expectTypeOf(fool(vEffect)).toEqualTypeOf<
      virentia.Effect<number, string, boolean> & EffectorEffect<number, string, boolean>
    >();
  });

  it("virentia.StoreWritable<T> -> StoreWritable<T> & EffectorEventCallable<T>", () => {
    expectTypeOf(fool(vStoreWritable)).toEqualTypeOf<
      virentia.StoreWritable<number> & EffectorEventCallable<number>
    >();
  });

  it("virentia.Store<T> (readonly) -> Store<T> & EffectorEventCallable<T>", () => {
    expectTypeOf(fool(vStore)).toEqualTypeOf<
      virentia.Store<number> & EffectorEventCallable<number>
    >();
  });

  it("StoreWritable is NOT collapsed onto the readonly Store overload", () => {
    // If the writable overload were skipped this would fail (Store !== StoreWritable).
    expectTypeOf(fool(vStoreWritable)).not.toEqualTypeOf<
      virentia.Store<number> & EffectorEventCallable<number>
    >();
  });
});

describe("fool() — effector-direction overload return types (mirror)", () => {
  it("EffectorEventCallable<T> -> EffectorEventCallable<T> & virentia.EventCallable<T>", () => {
    expectTypeOf(fool(eEventCallable)).toEqualTypeOf<
      EffectorEventCallable<number> & virentia.EventCallable<number>
    >();
  });

  it("EffectorEffect<P,D,F> -> EffectorEffect<P,D,F> & virentia.Effect<P,D,F>", () => {
    expectTypeOf(fool(eEffect)).toEqualTypeOf<
      EffectorEffect<number, string, boolean> & virentia.Effect<number, string, boolean>
    >();
  });

  it("EffectorUnitTargetable<T> -> EffectorUnitTargetable<T> & virentia.EventCallable<T>", () => {
    expectTypeOf(fool(eUnitTargetable)).toEqualTypeOf<
      EffectorUnitTargetable<number> & virentia.EventCallable<number>
    >();
  });

  it("EffectorUnit<T> -> EffectorUnit<T> & virentia.EventCallable<T>", () => {
    expectTypeOf(fool(eUnit)).toEqualTypeOf<
      EffectorUnit<number> & virentia.EventCallable<number>
    >();
  });

  it("EffectorStoreWritable<T> resolves via the UnitTargetable overload", () => {
    // A writable effector store extends UnitTargetable but not EventCallable,
    // so it matches the UnitTargetable overload — NOT a store-specific one
    // (there is none on the effector side).
    expectTypeOf(fool(eStoreWritable)).toEqualTypeOf<
      EffectorUnitTargetable<number> & virentia.EventCallable<number>
    >();
  });

  it("TYPE/RUNTIME DIVERGENCE: fooling an effector Store drops its Store surface", () => {
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

  it("effect intersection is order-independent between the two directions", () => {
    expectTypeOf(fool(eEffect)).toEqualTypeOf<
      virentia.Effect<number, string, boolean> & EffectorEffect<number, string, boolean>
    >();
  });
});

describe("fool() — payload edge cases (void / union / readonly / optional / nested)", () => {
  it("void payload keeps void through the intersection", () => {
    expectTypeOf(fool(vEventVoid)).toEqualTypeOf<
      virentia.EventCallable<void> & EffectorEventCallable<void>
    >();
  });

  it("union payload does NOT distribute the intersection over the union", () => {
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

  it("readonly members of the payload are preserved", () => {
    expectTypeOf(fool(vEventReadonly)).toEqualTypeOf<
      virentia.EventCallable<{ readonly id: string }> &
        EffectorEventCallable<{ readonly id: string }>
    >();
  });

  it("optional members of the payload are preserved", () => {
    expectTypeOf(fool(vEventOptional)).toEqualTypeOf<
      virentia.EventCallable<{ id?: string }> & EffectorEventCallable<{ id?: string }>
    >();
  });

  it("nested generics survive the intersection", () => {
    expectTypeOf(fool(vEventNested)).toEqualTypeOf<
      virentia.EventCallable<Array<Map<string, number>>> &
        EffectorEventCallable<Array<Map<string, number>>>
    >();
  });
});

describe("fool() — dual-identity usability of the returned unit", () => {
  it("a fooled virentia event exposes both Effector and Virentia surface", () => {
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

  it("a fooled effector event is usable on both sides too", () => {
    const fooled = fool(eEventCallable);
    expectTypeOf(fooled).toHaveProperty("kind");
    expectTypeOf(fooled).toHaveProperty("node");
    expectTypeOf(fooled).toHaveProperty("map");
    expectTypeOf(fooled).toBeCallableWith(5);
  });

  it("a fooled effect keeps its done/fail projections and pending store", () => {
    const fooled = fool(vEffect);
    expectTypeOf(fooled).toHaveProperty("done");
    expectTypeOf(fooled).toHaveProperty("fail");
    expectTypeOf(fooled).toHaveProperty("pending");
    expectTypeOf(fooled).toHaveProperty("kind");
    expectTypeOf(fooled).toBeCallableWith(5);
  });

  it("a fooled non-callable virentia Event becomes callable via the effector side", () => {
    // The input `virentia.Event<number>` is NOT callable on its own.
    expectTypeOf(vEvent).not.toBeFunction();
    // After fooling, the EffectorEventCallable intersection makes it callable.
    expectTypeOf(fool(vEvent)).toBeCallableWith(5);
  });
});

describe("fool() — negative cases (must be compile errors)", () => {
  it("rejects primitives and non-units", () => {
    // @ts-expect-error number is not a bridgeable unit
    fool(42);
    // @ts-expect-error string is not a bridgeable unit
    fool("nope");
    // @ts-expect-error null is not a bridgeable unit
    fool(null);
    // @ts-expect-error plain object is not a bridgeable unit
    fool({ foo: 1 });
  });

  it("rejects a union spanning both bridge families (no single overload matches)", () => {
    // @ts-expect-error overloads cannot accept an already-merged cross-family union
    fool(mixedFamily);
  });
});

describe("fool() — cross-framework intersection smoke checks", () => {
  it("virentia-direction overloads intersect both frameworks", () => {
    expectTypeOf(fool(event<number>())).toMatchTypeOf<VirentiaEventCallable<number>>();
    expectTypeOf(fool(event<number>())).toMatchTypeOf<EffectorEventCallable<number>>();
    // A fooled virentia effect is callable as an effector effect at runtime; the exact
    // intersection-type surface is asserted in the dedicated type-test wave.
    const vfx = fool(effect(async (p: number): Promise<number> => p));
    expectTypeOf(vfx).toMatchTypeOf<VirentiaEffect<number, number, unknown>>();
  });

  it("effector-direction overloads intersect both frameworks", () => {
    expectTypeOf(fool(createEvent<number>())).toMatchTypeOf<EffectorEventCallable<number>>();
    expectTypeOf(fool(createEvent<number>())).toMatchTypeOf<VirentiaEventCallable<number>>();
  });
});

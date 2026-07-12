import { describe, expectTypeOf, it } from "vitest";
import { store } from "@virentia/core";
import type { Effect, EffectCallOptions, EventCallable, Store, StoreWritable } from "@virentia/core";
import type { Ref } from "vue";
import type { ComponentModel, ReactiveModel } from "../../lib";

// ---------------------------------------------------------------------------
// ReactiveModel: react parity but with UnitRef (stores -> refs)
// ---------------------------------------------------------------------------
describe("ReactiveModel", () => {
  it("exposes primitive store fields as readonly refs", () => {
    type View = ReactiveModel<{ saving: StoreWritable<boolean>; message: Store<string | null> }>;
    expectTypeOf<View["saving"]>().toEqualTypeOf<Readonly<Ref<boolean>>>();
    expectTypeOf<View["message"]>().toEqualTypeOf<Readonly<Ref<string | null>>>();
  });

  // TODO(phase-2 dedup): overlaps "exposes primitive store fields as readonly refs"
  it("exposes inferred primitive store fields as readonly refs", () => {
    const saving = store(false);
    const message = store<string | null>(null);
    const model = { saving, message };
    type View = ReactiveModel<typeof model>;
    expectTypeOf<View["saving"]>().toEqualTypeOf<Readonly<Ref<boolean>>>();
    expectTypeOf<View["message"]>().toEqualTypeOf<Readonly<Ref<string | null>>>();
  });

  it("exposes event/effect fields as scope-bound callables", () => {
    type View = ReactiveModel<{
      submit: EventCallable<string>;
      reset: EventCallable<void>;
      load: Effect<number, string, Error>;
    }>;
    expectTypeOf<View["submit"]>().toEqualTypeOf<(payload: string) => Promise<void>>();
    expectTypeOf<View["reset"]>().toEqualTypeOf<(payload?: void) => Promise<void>>();
    expectTypeOf<View["load"]>().toEqualTypeOf<
      (params: number, options?: EffectCallOptions) => Promise<string>
    >();
  });

  it("omits the string 'dispose' key from the resolved type (T1)", () => {
    type View = ReactiveModel<{ count: Store<number>; dispose(): void }>;
    expectTypeOf<keyof View>().toEqualTypeOf<"count">();
  });

  // TODO(phase-2 dedup): overlaps "omits the string 'dispose' key from the resolved type (T1)"
  it("drops the dispose key", () => {
    type View = ReactiveModel<{ count: Store<number>; dispose(): void }>;
    expectTypeOf<"dispose" extends keyof View ? true : false>().toEqualTypeOf<false>();
  });

  it("keeps method fields unchanged", () => {
    type View = ReactiveModel<{ run: () => void; compute: (n: number) => string }>;
    expectTypeOf<View["run"]>().toEqualTypeOf<() => void>();
    expectTypeOf<View["compute"]>().toEqualTypeOf<(n: number) => string>();
  });

  it("keeps primitive fields unchanged", () => {
    type View = ReactiveModel<{ label: string; n: number; flag: boolean; u: string | number }>;
    expectTypeOf<View["label"]>().toEqualTypeOf<string>();
    expectTypeOf<View["n"]>().toEqualTypeOf<number>();
    expectTypeOf<View["flag"]>().toEqualTypeOf<boolean>();
    expectTypeOf<View["u"]>().toEqualTypeOf<string | number>();
  });

  it("preserves optional primitive fields as optional (including undefined)", () => {
    type View = ReactiveModel<{ label?: string }>;
    expectTypeOf<View["label"]>().toEqualTypeOf<string | undefined>();
    // The optional modifier survives the mapped type.
    expectTypeOf<{} extends View ? true : false>().toEqualTypeOf<true>();
  });

  it("unwraps units nested at depth while recursing plain objects (T2)", () => {
    type View = ReactiveModel<{
      group: { flag: Store<boolean>; deeper: { count: Store<number> } };
    }>;
    expectTypeOf<View["group"]["flag"]>().toEqualTypeOf<Readonly<Ref<boolean>>>();
    expectTypeOf<View["group"]["deeper"]["count"]>().toEqualTypeOf<Readonly<Ref<number>>>();
  });

  it("keeps array fields RAW to match runtime (no element unwrap)", () => {
    type View = ReactiveModel<{ items: Store<number>[]; tuple: readonly [Store<boolean>] }>;
    expectTypeOf<View["items"]>().toEqualTypeOf<Store<number>[]>();
    expectTypeOf<View["tuple"]>().toEqualTypeOf<readonly [Store<boolean>]>();
  });

  it("passes a ComponentModel field through unchanged (not unwrapped) (T3)", () => {
    type Child = ComponentModel<{ n: Store<number> }>;
    type View = ReactiveModel<{ child: Child }>;
    expectTypeOf<View["child"]>().toEqualTypeOf<ComponentModel<{ n: Store<number> }>>();
    // The child's own units stay raw (not rebound to refs).
    expectTypeOf<View["child"]["n"]>().toEqualTypeOf<Store<number>>();
  });

  it("recurses a plain object while passing a sibling ComponentModel through", () => {
    type Child = ComponentModel<{ n: Store<number> }>;
    type View = ReactiveModel<{ plain: { s: Store<number> }; child: Child }>;
    expectTypeOf<View["plain"]["s"]>().toEqualTypeOf<Readonly<Ref<number>>>();
    expectTypeOf<View["child"]["n"]>().toEqualTypeOf<Store<number>>();
  });

  it("makes every carried key readonly", () => {
    type View = ReactiveModel<{ count: Store<number> }>;
    // Mutating the mapped property must be rejected: the mapped type adds `readonly`.
    expectTypeOf<View>().toEqualTypeOf<{ readonly count: Readonly<Ref<number>> }>();
  });

  it("resolves an empty model to an empty object", () => {
    expectTypeOf<ReactiveModel<{}>>().toEqualTypeOf<{}>();
  });

  it("carries a non-unit object field with a `.node` prop as a NEVER leak (bug: should recurse)", () => {
    type View = ReactiveModel<{ weird: { node: string; label: string } }>;
    // BUG: the `{ readonly node: unknown }` unit-heuristic matches any object that
    // merely has a `node` field. UnitRef then fails every unit branch and leaks
    // `never`. The correct behaviour would be to recurse the plain object.
    // @ts-expect-error documents the never-leak: `weird` resolves to `never`.
    expectTypeOf<View["weird"]>().toEqualTypeOf<{ readonly node: string; readonly label: string }>();
    // Confirm the actual (wrong) resolved type is `never`.
    expectTypeOf<View["weird"]>().toEqualTypeOf<never>();
  });

  it("retains a Symbol.dispose key that runtime buildReactiveModel actually skips (type/runtime divergence)", () => {
    type View = ReactiveModel<{ count: Store<number>; [Symbol.dispose](): void }>;
    // DIVERGENCE: `buildReactiveModel` skips the Symbol.dispose key at runtime, but
    // ReactiveModel only remaps the string "dispose" so the symbol key survives in
    // the type. The correct (runtime-matching) key set is just "count".
    // @ts-expect-error documents that the symbol key is not omitted at the type level.
    expectTypeOf<keyof View>().toEqualTypeOf<"count">();
    // Actual behaviour: the symbol key is retained alongside "count".
    expectTypeOf<keyof View>().toEqualTypeOf<"count" | typeof Symbol.dispose>();
  });
});

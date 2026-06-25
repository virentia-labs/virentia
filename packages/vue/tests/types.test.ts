import { describe, expectTypeOf, it } from "vitest";
import { event, effect, reactive, store } from "@virentia/core";
import type { Ref } from "vue";
import type { ReactiveModel, UnitRef, UnitValue } from "../lib";

describe("@virentia/vue reactive types", () => {
  it("UnitValue unwraps primitive stores to their value type", () => {
    // Regression: primitive stores must not leak `{ value: T } & StoreApi<T>`
    // into the resolved type (caused by a distributive `T extends object`).
    expectTypeOf<UnitValue<ReturnType<typeof store<boolean>>>>().toEqualTypeOf<boolean>();
    expectTypeOf<UnitValue<ReturnType<typeof store<string>>>>().toEqualTypeOf<string>();
    expectTypeOf<UnitValue<ReturnType<typeof store<string | null>>>>().toEqualTypeOf<
      string | null
    >();
  });

  it("UnitRef exposes primitive stores as readonly refs of the value type", () => {
    expectTypeOf<UnitRef<ReturnType<typeof store<boolean>>>>().toEqualTypeOf<
      Readonly<Ref<boolean>>
    >();
    expectTypeOf<UnitRef<ReturnType<typeof store<string | null>>>>().toEqualTypeOf<
      Readonly<Ref<string | null>>
    >();
  });

  it("unwraps object reactives and event/effect units", () => {
    const user = reactive({ name: "", age: 0 });
    const submit = event<string>();
    const loadFx = effect(async (id: number) => id.toString());
    expectTypeOf<UnitRef<typeof user>>().toEqualTypeOf<
      Readonly<Ref<{ name: string; age: number }>>
    >();
    expectTypeOf<UnitRef<typeof submit>>().toEqualTypeOf<(payload: string) => Promise<void>>();
    expectTypeOf<UnitRef<typeof loadFx>>().parameter(0).toEqualTypeOf<number>();
  });

  it("ReactiveModel exposes primitive store fields as readonly refs", () => {
    const saving = store(false);
    const message = store<string | null>(null);
    const model = { saving, message };
    type View = ReactiveModel<typeof model>;
    expectTypeOf<View["saving"]>().toEqualTypeOf<Readonly<Ref<boolean>>>();
    expectTypeOf<View["message"]>().toEqualTypeOf<Readonly<Ref<string | null>>>();
  });
});
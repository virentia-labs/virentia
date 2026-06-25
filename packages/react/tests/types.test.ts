import { describe, expectTypeOf, it } from "vitest";
import { event, effect, reactive, store } from "@virentia/core";
import type { ReactiveModel, UnitValue } from "../lib";

describe("@virentia/react reactive types", () => {
  it("unwraps primitive stores to their value type", () => {
    // Regression: primitive stores must not leak `{ value: T } & StoreApi<T>`
    // into the resolved type (caused by a distributive `T extends object`).
    expectTypeOf<UnitValue<ReturnType<typeof store<boolean>>>>().toEqualTypeOf<boolean>();
    expectTypeOf<UnitValue<ReturnType<typeof store<string>>>>().toEqualTypeOf<string>();
    expectTypeOf<UnitValue<ReturnType<typeof store<number>>>>().toEqualTypeOf<number>();
    expectTypeOf<UnitValue<ReturnType<typeof store<string | null>>>>().toEqualTypeOf<
      string | null
    >();
  });

  it("unwraps object reactives to their state", () => {
    const user = reactive({ name: "", age: 0 });
    expectTypeOf<UnitValue<typeof user>>().toEqualTypeOf<{ name: string; age: number }>();
  });

  it("unwraps events and effects to bound callables", () => {
    const submit = event<string>();
    const loadFx = effect(async (id: number) => id.toString());
    expectTypeOf<UnitValue<typeof submit>>().toEqualTypeOf<(payload: string) => Promise<void>>();
    expectTypeOf<UnitValue<typeof loadFx>>().parameter(0).toEqualTypeOf<number>();
    expectTypeOf<UnitValue<typeof loadFx>>().returns.toEqualTypeOf<Promise<string>>();
  });

  it("ReactiveModel unwraps primitive store fields", () => {
    const saving = store(false);
    const message = store<string | null>(null);
    const model = { saving, message };
    type View = ReactiveModel<typeof model>;
    expectTypeOf<View["saving"]>().toEqualTypeOf<boolean>();
    expectTypeOf<View["message"]>().toEqualTypeOf<string | null>();
  });
});

import { describe, expectTypeOf, it } from "vitest";
import { event } from "../../lib";
import type { Event, EventCallable, EventPayload } from "../../lib";

describe("event types", () => {
  it("computes EventPayload for void / required / optional / unknown", () => {
    expectTypeOf<EventPayload<string>>().toEqualTypeOf<[payload: string]>();
    expectTypeOf<EventPayload<number>>().toEqualTypeOf<[payload: number]>();
    expectTypeOf<EventPayload<void>>().toEqualTypeOf<[payload?: void]>();
    expectTypeOf<EventPayload<string | undefined>>().toEqualTypeOf<[payload?: string | undefined]>();
    expectTypeOf<EventPayload<unknown>>().toEqualTypeOf<[payload?: unknown]>();
    // union payload without undefined stays required.
    expectTypeOf<EventPayload<string | number>>().toEqualTypeOf<[payload: string | number]>();
  });

  it("infers event() callable shapes", () => {
    expectTypeOf(event<string>()).toEqualTypeOf<EventCallable<string>>();
    expectTypeOf(event()).toEqualTypeOf<EventCallable<void>>();

    // required payload: exactly one argument.
    expectTypeOf(event<string>()).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(event<string>()).returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf(event<string>()).toBeCallableWith("hi");

    // void / optional payloads are callable with no argument.
    expectTypeOf(event()).toBeCallableWith();
    expectTypeOf(event()).toBeCallableWith(undefined);
    expectTypeOf(event<number | undefined>()).toBeCallableWith();
  });

  it("infers event operator return types", () => {
    const ev = event<string>();
    expectTypeOf(ev.map((v) => v.length)).toEqualTypeOf<Event<number>>();
    expectTypeOf(ev.filter((v) => v.length > 0)).toEqualTypeOf<Event<string>>();
    // filterMap maps to Next (undefined-return is the drop signal).
    expectTypeOf(ev.filterMap((v) => (v ? v.length : undefined))).toEqualTypeOf<Event<number>>();
  });

  it("distinguishes void arity, required payloads, and non-callable derived events", () => {
    const voidEvent = event<void>();
    const numberEvent = event<number>();
    const mapped = numberEvent.map((value) => value + 1);

    expectTypeOf(voidEvent).toBeCallableWith();
    expectTypeOf(numberEvent).toBeCallableWith(1);
    expectTypeOf<EventPayload<void>>().toEqualTypeOf<[payload?: void]>();
    expectTypeOf<EventPayload<number>>().toEqualTypeOf<[payload: number]>();
    // A derived event is Event, not EventCallable.
    expectTypeOf(mapped).toMatchTypeOf<Event<number>>();
    expectTypeOf(mapped).not.toMatchTypeOf<EventCallable<number>>();
  });
});

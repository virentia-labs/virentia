/** @jsxImportSource @virentia/ui */
import { describe, expectTypeOf, it } from "vitest";
import type { EventCallable } from "@virentia/core";
import { action, store } from "../../lib";

describe("action types", () => {
  it("can be called without a payload or used directly as a DOM handler", () => {
    function Counter() {
      const count = store(0);
      const increment = action(() => {
        count.value++;
      });
      expectTypeOf(increment).toMatchTypeOf<EventCallable<unknown>>();
      void increment();
      return <button onClick={increment}>{count.value}</button>;
    }
    expectTypeOf(Counter).toBeFunction();
  });

  it("infers a typed payload for programmatic actions", () => {
    function example() {
      const setCount = action((amount: number) => {
        void amount;
      });
      expectTypeOf(setCount).toMatchTypeOf<EventCallable<number>>();
      void setCount(2);
      // @ts-expect-error actions reject payloads of the wrong type
      void setCount("two");
    }
    expectTypeOf(example).toBeFunction();
  });
});

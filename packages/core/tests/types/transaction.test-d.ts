import { describe, expectTypeOf, it } from "vitest";
import { scope } from "../../lib";
import { readTransactionStore, withTransaction, writeTransactionStore } from "../../lib/internal";

describe("transaction internal types", () => {
  it("types a transaction read as the value or the sentinel", () => {
    const r = readTransactionStore<number>(scope(), Symbol());
    // The union must not be assignable to a bare number (sentinel branch present).
    expectTypeOf(r).not.toEqualTypeOf<number>();
    expectTypeOf<number>().toMatchTypeOf<typeof r>();
  });

  it("types the write value against the target's value type", () => {
    expectTypeOf(writeTransactionStore<number>).parameter(1).toEqualTypeOf<number>();
  });

  it("infers withTransaction's return type from the callback", () => {
    const result = withTransaction(() => "hello");
    expectTypeOf(result).toEqualTypeOf<string>();
  });
});

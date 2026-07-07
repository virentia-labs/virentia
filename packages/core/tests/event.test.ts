import { describe, expect, it } from "vitest";
import { event, reaction, scope, scoped } from "../lib";
import { node, run } from "../lib/internal";
import { nameUnit } from "../lib/devtools";

describe("event", () => {
  it("requires an active scope when called as a function", async () => {
    const submitted = event<number>();

    const callWithoutScope = () => submitted(1);

    expect(callWithoutScope).toThrow("Scope is required");
  });

  it("names the offending unit and how to provide a scope when called without one", () => {
    const submitted = event<number>("submitted");

    expect(() => submitted(1)).toThrow(/Scope is required to call event "submitted"/);
    expect(() => submitted(1)).toThrow(/scoped/);
  });

  it("reports the unit path that led to a scope-less call inside a handler", async () => {
    const inner = event<number>("inner");
    const caller = node({
      run(ctx) {
        // Runs with no active scope; calling a unit from here must fail and the
        // error should name the chain of units that led to the offending call.
        inner(ctx.value as number);
      },
    });

    nameUnit(caller, "caller");

    await expect(run({ unit: caller, payload: 1 })).rejects.toThrow(
      /Unit path that led here: .*caller.* → .*event "inner"/,
    );
  });

  it("runs explicit reactions when called in a scope", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const values: number[] = [];
    reaction({
      on: submitted,
      run: (value: number) => {
        values.push(value);
      },
    });

    await scoped(appScope, () => submitted(3));

    expect(values).toEqual([3]);
  });

  it("derives events with map, filter, and filterMap", async () => {
    const appScope = scope();
    const submitted = event<number>();
    const doubled = submitted.map((value) => value * 2);
    const even = submitted.filter((value) => value % 2 === 0);
    const label = submitted.filterMap((value) => (value > 2 ? `#${value}` : undefined));
    const values: unknown[] = [];

    reaction({
      on: doubled,
      run: (value: number) => {
        values.push(["doubled", value]);
      },
    });
    reaction({
      on: even,
      run: (value: number) => {
        values.push(["even", value]);
      },
    });
    reaction({
      on: label,
      run: (value: string) => {
        values.push(["label", value]);
      },
    });

    await scoped(appScope, () => submitted(2));
    await scoped(appScope, () => submitted(3));

    expect(values).toEqual([
      ["doubled", 4],
      ["even", 2],
      ["doubled", 6],
      ["label", "#3"],
    ]);
  });
});

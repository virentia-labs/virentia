import { describe, expect, it } from "vitest";
import { event, getCurrentScope, reaction, scope, scoped } from "../../lib";
import { bindEventToScope } from "../../lib/internal";

describe("scope-bound event views", () => {
  it("shares the source node but routes each instance reaction to its own scope", async () => {
    const source = event<string>();
    const firstScope = scope();
    const secondScope = scope();
    const first = bindEventToScope(source, firstScope);
    const second = bindEventToScope(source, secondScope);
    const seen: string[] = [];

    expect(first.node).toBe(source.node);
    expect(second.node).toBe(source.node);

    reaction({
      on: first,
      run: (value, api) => seen.push(`first:${value}:${api.scope === firstScope}`),
    });
    reaction({
      on: second,
      run: (value, api) => seen.push(`second:${value}:${api.scope === secondScope}`),
    });

    await first("a");
    await second("b");

    expect(seen).toEqual(["first:a:true", "second:b:true"]);
  });

  it("keeps map, filter, and filterMap callbacks and reactions in the bound scope", async () => {
    const source = event<number>();
    const firstScope = scope();
    const secondScope = scope();
    const mappedReads: string[] = [];
    const filteredReads: string[] = [];
    const mapped = bindEventToScope(source, firstScope).map((value) => {
      mappedReads.push(`map:${value}`);
      return value * 2;
    });
    const filtered = bindEventToScope(source, firstScope).filter((value) => {
      filteredReads.push(`filter:${value}`);
      return value > 1;
    });
    const filterMapped = bindEventToScope(source, firstScope).filterMap((value) => {
      filteredReads.push(`filterMap:${value}`);
      return value > 1 ? String(value) : undefined;
    });
    const seen: string[] = [];

    reaction({ on: mapped, run: (value) => seen.push(`map:${value}`) });
    reaction({ on: filtered, run: (value) => seen.push(`filter:${value}`) });
    reaction({ on: filterMapped, run: (value) => seen.push(`filterMap:${value}`) });

    await scoped(secondScope, () => source(3));
    expect(mappedReads).toEqual([]);
    expect(filteredReads).toEqual([]);
    expect(seen).toEqual([]);

    await scoped(firstScope, () => source(1));
    await scoped(firstScope, () => source(3));

    expect(mappedReads).toEqual(["map:1", "map:3"]);
    expect(filteredReads).toEqual(["filter:1", "filterMap:1", "filter:3", "filterMap:3"]);
    expect(seen).toHaveLength(4);
    expect(seen).toEqual(expect.arrayContaining(["map:2", "map:6", "filter:3", "filterMap:3"]));
  });

  it("lets an explicit reaction scope override the event binding", async () => {
    const source = event<number>();
    const firstScope = scope();
    const secondScope = scope();
    const first = bindEventToScope(source, firstScope);
    const seen: number[] = [];

    reaction({ on: first, scope: secondScope, run: (value) => seen.push(value) });

    await first(1);
    await scoped(secondScope, () => source(2));
    expect(seen).toEqual([2]);
  });

  it("rejects sources bound to different scopes in one reaction", () => {
    const source = event<number>();
    const first = bindEventToScope(source, scope());
    const second = bindEventToScope(source, scope());

    expect(() => reaction({ on: [first, second], run() {} })).toThrow(/different scopes/);
    expect(() => reaction({ on: [first, second], scope: scope(), run() {} })).toThrow(
      /different scopes/,
    );
  });

  it("leaves ordinary event reactions global and restores the caller scope", async () => {
    const source = event<void>();
    const firstScope = scope();
    const secondScope = scope();
    const first = bindEventToScope(source, firstScope);
    const seen: unknown[] = [];

    reaction({ on: source, run: (_value, api) => seen.push(api.scope) });

    await scoped(secondScope, async () => {
      await first();
      expect(getCurrentScope()).toBe(secondScope);
      await source();
    });

    expect(seen).toEqual([firstScope, secondScope]);
    expect(getCurrentScope()).toBeNull();
  });
});

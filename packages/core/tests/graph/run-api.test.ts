import { describe, expect, it } from "vitest";
import {
  event,
  reaction,
  scope,
  scoped,
  type Reaction,
  type ReactionEffectApi,
  type Scope,
} from "../../lib";
import { takesRunApi } from "../../lib/graph/reaction";
import { f, staticModel } from "../../lib/models";
import { collection } from "../../lib/models/collection";

// An explicit reaction gets its `{ scope, signal }` object only when its body
// can see a second argument. The test source is reprinted by the transform, so
// each body is built from exact text: strict, like a module, unless noted.
const strict = (code: string): unknown => new Function(`"use strict"; return (${code});`)();
const sloppy = (code: string): unknown => new Function(`return (${code});`)();

describe("whether a run body can see its api", () => {
  it.each([
    "() => 1",
    "(v) => v",
    "v => v",
    "( v ) => v",
    "(v)=>v",
    "async (v) => v",
    "async(v)=>v",
    "async v => v",
    "async => async",
    "($) => $",
    "(_v1) => _v1",
    "(значение) => значение",
    "function (v) { return v; }",
    "function named(v) { return v; }",
    "async function (v) { return v; }",
    "function* (v) { yield v; }",
    "{ run(v) { return v; } }.run",
    "{ async run(v) { return v; } }.run",
    "{ *run(v) { yield v; } }.run",
    "{ run() {} }.run",
    "(v) => { const text = 'evaluate the argument'; return text + v; }",
  ])("cannot: %s", (code) => {
    expect(takesRunApi(strict(code))).toBe(false);
  });

  it.each([
    "(v, api) => api",
    "(v, ...rest) => rest",
    "(...args) => args",
    "(v, api = null) => api",
    "(v = 1) => v",
    "({ a }) => a",
    "([a]) => a",
    "(v /* api */) => v",
    "(v,) => v",
    "function (v) { return arguments[1]; }",
    "function (v) { return eval('arguments[1]'); }",
    "(v) => eval('v')",
    "function (v) { return \\u0061rguments[1]; }",
    "{ ['run'](v) {} }.run",
    "{ 'run'(v) {} }.run",
    "((v) => v).bind(null)",
    "new Proxy((v) => v, {})",
    "console.log",
  ])("can or may: %s", (code) => {
    expect(takesRunApi(strict(code))).toBe(true);
  });

  it("can: a sloppy-mode function, whose arguments other code reads", () => {
    expect(takesRunApi(sloppy("function (v) { return v; }"))).toBe(true);
    expect(takesRunApi(sloppy("(v) => v"))).toBe(false);
  });

  it("can: anything that is not a function", () => {
    expect(takesRunApi(undefined)).toBe(true);
  });
});

describe("a body that can see its api", () => {
  const seenBy = (run: unknown): ReactionEffectApi | undefined => {
    const app = scope(),
      tick = event<number>();
    const r = reaction({ on: tick, run: run as (value: number) => void });
    try {
      scoped(app, () => tick(1));
    } finally {
      r.stop();
    }
    return seen.pop();
  };
  const seen: (ReactionEffectApi | undefined)[] = [];
  const record = (api: ReactionEffectApi | undefined): void => void seen.push(api);

  it("gets it through arguments", () => {
    const run = new Function(
      "record",
      `"use strict"; return function (v) { record(arguments[1]); };`,
    )(record);
    expect(seenBy(run)?.signal).toBeInstanceOf(AbortSignal);
  });

  it("gets it through a direct eval", () => {
    const run = new Function(
      "record",
      `"use strict"; return function (v) { record(eval("arguments[1]")); };`,
    )(record);
    expect(seenBy(run)?.signal).toBeInstanceOf(AbortSignal);
  });

  it("gets it when other code reads a sloppy body's arguments", () => {
    const run = new Function(
      "record",
      `return function run(v) { (function peek() { record(run.arguments[1]); })(); };`,
    )(record);
    expect(seenBy(run)?.signal).toBeInstanceOf(AbortSignal);
  });

  it("gets it through a bound function", () => {
    const run = function (this: unknown, _v: number, api: ReactionEffectApi) {
      record(api);
    }.bind(null);
    expect(seenBy(run)?.signal).toBeInstanceOf(AbortSignal);
  });

  it("gets the scope it fired in", () => {
    const app = scope(),
      tick = event<number>();
    const scopes: Scope[] = [];
    const named = reaction({
      on: tick,
      run: (...args: unknown[]) => void scopes.push((args[1] as ReactionEffectApi).scope),
    });
    try {
      scoped(app, () => tick(1));
    } finally {
      named.stop();
    }
    expect(scopes).toEqual([app]);
  });

  it("is judged on the first run, so creating a reaction costs nothing more", () => {
    const app = scope(),
      tick = event<number>();
    const r = reaction({ on: tick, run: (value) => void value });
    const node = r.node as { takesApi?: boolean };
    try {
      expect(node.takesApi).toBeUndefined();
      scoped(app, () => tick(1));
      expect(node.takesApi).toBe(false);
    } finally {
      r.stop();
    }
  });

  it("gets it inside a static model, through the model's own wrapper", async () => {
    const tick = event<number>();
    const signals: unknown[] = [];
    const runs: string[] = [];
    const takes: boolean[] = [];
    const takesOf = (r: Reaction): number => takes.push((r.node as { takesApi?: boolean }).takesApi!);
    const Todo: any = staticModel({
      data: { title: f.string() },
      setup(self: any) {
        takesOf(
          reaction({
            on: tick,
            run: (_value, api) => void signals.push(api.signal),
          }),
        );
        // Judged on the body as written, not on the wrapper that forwards it.
        takesOf(
          reaction({
            on: tick,
            run: (value) => void runs.push(`${self.title.value} ${value}`),
          }),
        );
      },
    });
    expect(takes).toEqual([true, false]);
    await scoped(scope(), async () => {
      const todos: any = collection(Todo);
      todos.add({ title: "a" });
      todos.add({ title: "b" });
      await tick(1);
    });
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
    expect(runs).toEqual(["a 1", "b 1"]);
  });
});

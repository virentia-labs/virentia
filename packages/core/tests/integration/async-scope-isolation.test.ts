import { describe, expect, it } from "vitest";
import { effect, event, getCurrentScope, reaction, scope, scoped, store } from "../../lib";
import { f, staticModel } from "../../lib/models";
import { collection } from "../../lib/models/collection";
import { node, run } from "../../lib/internal";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("direct unit await context", () => {
  it("does not reattach a parked parent drain after a nested asynchronous failure", async () => {
    const current = scope();
    const failure = new Error("nested failure");
    const seen: string[] = [];
    const fails = node(async () => {
      await Promise.resolve();
      throw failure;
    });
    const succeeds = node(() => {
      seen.push("next");
    });
    const parent = node(async () => {
      try {
        await run({ unit: fails, scope: current });
      } catch (error) {
        expect(error).toBe(failure);
      }
      await run({ unit: succeeds, scope: current });
      seen.push("parent");
    });
    await expect(run({ unit: parent, scope: current })).rejects.toBe(failure);
    expect(seen).toEqual(["next", "parent"]);
    expect(getCurrentScope()).toBeNull();
  });
  it("keeps one hundred interleaved unit continuations isolated", async () => {
    const scopes = Array.from({ length: 100 }, () => scope());
    const gates = scopes.map(() => deferred());
    const wait = effect((index: number) => gates[index].promise);
    const value = store(-1);
    const jobs = scopes.map((current, index) =>
      scoped(current, async () => {
        await wait(index);
        expect(getCurrentScope()).toBe(current);
        value.value = index;
        await wait(index);
        expect(getCurrentScope()).toBe(current);
        expect(value.value).toBe(index);
      }),
    );
    for (let index = gates.length - 1; index >= 0; index--) gates[index].resolve();
    await Promise.all(jobs);
    expect(getCurrentScope()).toBeNull();
    expect(scopes.map((current) => scoped(current, () => value.value))).toEqual(
      scopes.map((_, index) => index),
    );
  });
  it("isolates concurrent effects settling in the same turn", async () => {
    const first = scope();
    const second = scope();
    const gates = [deferred(), deferred()];
    const wait = effect((index: number) => gates[index].promise);
    const value = store(0);
    const observations: unknown[] = [];
    const a = scoped(first, async () => {
      await wait(0);
      observations.push(getCurrentScope());
      value.value = 1;
    });
    const b = scoped(second, async () => {
      await wait(1);
      observations.push(getCurrentScope());
      value.value = 2;
    });
    expect(getCurrentScope()).toBeNull();
    gates.forEach((gate) => gate.resolve());
    await Promise.all([a, b]);
    expect(observations).toEqual([first, second]);
    expect(scoped(first, () => value.value)).toBe(1);
    expect(scoped(second, () => value.value)).toBe(2);
    expect(getCurrentScope()).toBeNull();
  });

  it("keeps native promises neutral instead of holding a shared ambient", async () => {
    const gates = [deferred(), deferred()];
    const scopes = [scope(), scope()];
    const observations: unknown[] = [];
    const jobs = scopes.map((current, index) =>
      scoped(current, async () => {
        await gates[index].promise;
        observations.push(getCurrentScope());
      }),
    );
    expect(getCurrentScope()).toBeNull();
    gates.forEach((gate) => gate.resolve());
    await Promise.all(jobs);
    expect(observations).toEqual([null, null]);
  });

  it("resumes shared static-model self after effects and events", async () => {
    const gates = [deferred(), deferred()];
    const wait = effect((index: number) => gates[index].promise);
    const finished = event();
    const Model = staticModel({
      data: { index: f.number(), count: f.number(0) },
      setup(self) {
        const start = event();
        reaction({
          on: start,
          run: async () => {
            await wait(self.index.value);
            self.count.value++;
            await finished();
            self.count.value++;
          },
        });
        return { start };
      },
    });
    const app = scope();
    const a = collection(Model, app).add({ id: "a", index: 0 });
    const b = collection(Model, app).add({ id: "b", index: 1 });
    const jobs = [a.start(), b.start()];
    gates.forEach((gate) => gate.resolve());
    await Promise.all(jobs);
    expect(a.count.value).toBe(2);
    expect(b.count.value).toBe(2);
    expect(getCurrentScope()).toBeNull();
  });
});

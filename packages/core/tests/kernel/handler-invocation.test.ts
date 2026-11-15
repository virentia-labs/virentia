import { expect, it } from "vitest";
import { computed, scope, store } from "../../lib";
import { node, run, type KernelExecutionContext, type Node } from "../../lib/internal";

it("invokes a public handler with its node receiver without consulting the handler's call property", async () => {
  const seen: unknown[] = [];
  let unit!: Node;
  const handler = function (this: Node, ctx: KernelExecutionContext) {
    seen.push(this === unit);
    return Number(ctx.value) + 1;
  };
  Object.defineProperty(handler, "call", {
    get() { throw Error("an own call property is not part of invoking a handler"); },
  });
  const downstream = node((ctx) => { seen.push(ctx.value); });
  unit = node({ run: handler, next: [downstream] });
  await run({ unit, payload: 3, scope: scope() });
  expect(seen).toEqual([true, 4]);
});

it("allows computed metadata and its handler to be overridden through the node API", async () => {
  const derived = computed(() => 1);
  const original = derived.node.run!;
  const seen: unknown[] = [];
  derived.node.meta = { application: "test" };
  derived.node.next = [node((ctx) => { seen.push(ctx.value); })];
  derived.node.run = function (ctx) {
    seen.push(this.meta!.application);
    return original.call(this, ctx);
  };
  await run({ unit: derived.node, scope: scope() });
  expect(seen).toEqual(["test", 1]);
});

for (const form of ["borrowed", "cloned", "proxied"] as const) {
  it(`runs a ${form} computed handler with an explicitly bound calculation receiver`, async () => {
    const source = store(1);
    const app = scope({ values: [[source, 7]] });
    const derived = computed(() => source.value * 2);
    const seen: unknown[] = [];
    const downstream = node((ctx) => { seen.push(ctx.value); });
    // Computed nodes now use class methods. Structural wrappers bind the
    // method to its original node, whose observers own the computed state.
    derived.node.next = [downstream];
    const handler = derived.node.run!.bind(derived.node);
    const unit = form === "borrowed"
      ? node({ run: handler, next: [downstream] })
      : form === "cloned"
        ? { ...derived.node, run: handler, next: [downstream] }
        : new Proxy(derived.node, {});
    if (form === "proxied") unit.run = handler;
    await run({ unit, payload: 999, scope: app });
    await run({ unit, payload: -999, scope: app });
    expect(seen).toEqual([14]);
  });
}

import { expect, it } from "vitest";
import { event, reaction, scope, scoped, serialize } from "../../lib";
import {
  modelDefaultCreator,
  modelDefinitionBindingOf,
  modelInstanceBindingOf,
} from "../../lib/internal";
import { staticModel } from "../../lib/models";
import { instanceInternalOf, instanceOfScope } from "../../lib/models/definition";

it("does not allocate an instance scope for an unused stateless static model", async () => {
  const Row = staticModel({ data: {} });
  const app = scope();
  const rows = modelDefinitionBindingOf(Row)!.collection(app);
  const handlers = app.handlers;
  let reads = 0;
  Object.defineProperty(app, "handlers", {
    get() {
      reads++;
      return handlers;
    },
  });
  const first = rows[modelDefaultCreator]!("first")!;
  const second = rows[modelDefaultCreator]!("second")!;
  const a = modelInstanceBindingOf(first)!,
    b = modelInstanceBindingOf(second)!;
  expect(reads).toBe(0);
  expect(a.homeScope).toBe(app);
  await a.disposeWithTrace!({});
  expect(reads).toBe(0);
  const home = b.scope;
  expect(reads).toBe(1);
  expect(home).not.toBe(app);
  expect(b.scope).toBe(home);
  expect(instanceOfScope(home)).toBe(instanceInternalOf(second));
  await b.disposeWithTrace!({});
});

it("enters the right instance when a stateless shared member first needs its context", async () => {
  const seen: string[] = [];
  const Row = staticModel({
    setup(self) {
      const ping = event();
      reaction({
        on: ping,
        run() {
          seen.push(self.id);
        },
      });
      return {
        ping,
        identify() {
          return self.id;
        },
      };
    },
  });
  const a = scoped(scope(), () => Row.create({ id: "a" }));
  const b = scoped(scope(), () => Row.create({ id: "b" }));
  expect([a.identify(), b.identify()]).toEqual(["a", "b"]);
  await a.ping();
  await b.ping();
  expect(seen).toEqual(["a", "b"]);
  await a.dispose();
  expect(() => a.identify()).toThrow("disposed");
  expect(b.identify()).toBe("b");
  await b.dispose();
});

it("restores and rebinds identity-only named instances before their scope is needed", async () => {
  const Row = staticModel({ name: "EmptyStaticIdentity", data: {} });
  const server = scope();
  const original = scoped(server, () => Row.create({}));
  const snapshot = serialize(server);
  const client = scope({ snapshot });
  const row = scoped(client, () => Row.create({}));
  expect(row.id).toBe(original.id);
  expect(serialize(client)).toEqual(snapshot);
  row.rebind("renamed");
  const before = serialize(client);
  expect(modelInstanceBindingOf(row)!.scope).toBeDefined();
  expect(serialize(client)).toEqual(before);
  await row.dispose();
  expect(JSON.stringify(serialize(client))).not.toContain("renamed");
});

it("keeps registry order and LINQ terminals correct across tail and middle removals", async () => {
  const Row = staticModel({ data: {} });
  const app = scope();
  const rows = scoped(app, () =>
    Array.from({ length: 5 }, (_, n) => Row.create({ id: String(n) })),
  );
  await rows[4].dispose();
  await rows[1].dispose();
  expect(scoped(app, () => Row.instances.items.map((row) => row.id))).toEqual(["0", "2", "3"]);
  scoped(app, () => Row.create({ id: "5" }));
  expect(scoped(app, () => Row.where((row) => row.id !== "2").items.map((row) => row.id))).toEqual([
    "0",
    "3",
    "5",
  ]);
});

it("preserves delayed slot recycling and generations even when no scope was allocated", async () => {
  const Row = staticModel({ data: {} });
  const app = scope();
  const first = scoped(app, () => Row.create({ id: "a" }));
  const key = /^s(\d+)g(\d+)$/.exec(first.key)!;
  first.dispose();
  const sameTick = scoped(app, () => Row.create({ id: "b" }));
  expect(/^s(\d+)g(\d+)$/.exec(sameTick.key)![1]).not.toBe(key[1]);
  await Promise.resolve();
  const reused = scoped(app, () => Row.create({ id: "a" }));
  expect(reused.key).toBe(`s${key[1]}g${Number(key[2]) + 1}`);
  expect(first.alive).toBe(false);
  expect(reused.alive).toBe(true);
});

it("does not resurrect disposed models when an unused binding scope is first accessed", async () => {
  const Row = staticModel({ name: "EmptyDisposedScope", data: {} });
  const app = scope();
  const old = scoped(app, () => Row.create({ id: "row" }));
  const binding = modelInstanceBindingOf(old)!;
  await old.dispose();
  const deadScope = binding.scope;
  const row = scoped(app, () => Row.create({ id: "row" }));
  expect(modelInstanceBindingOf(row)!.scope).not.toBe(deadScope);
  expect(instanceOfScope(deadScope)).toBe(instanceInternalOf(old));
  expect(instanceOfScope(deadScope)!.alive).toBe(false);
  expect(row.alive).toBe(true);
  expect(scoped(app, () => Row.get("row"))).toBe(row);
  await row.dispose();
  expect(JSON.stringify(serialize(app))).not.toContain("row");
});

it("keeps the original lazy snapshot address when an anonymous row is rebound before its first scope read", async () => {
  const Row = staticModel({ data: {} });
  const app = scope();
  const row = scoped(app, () => Row.create({ id: "original/id" }));
  row.rebind("next/id");
  const binding = modelInstanceBindingOf(row)!;
  expect(binding.identity).toBe("instance:anonymous:original%2Fid");
  expect(row.id).toBe("next/id");
  row.rebind("last/id");
  expect(binding.identity).toBe("instance:anonymous:original%2Fid");
  await row.dispose();
});

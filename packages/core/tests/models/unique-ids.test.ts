import { describe, expect, it } from "vitest";
import { scope, scoped } from "../../lib";
import { f, model, staticModel } from "../../lib/models";
import { collection } from "../../lib/models/collection";

// One id names at most one live instance of a model in a scope. A rebind or a
// creation that would share one is an error, generated ids skip taken ones,
// and add() with an existing id stays an upsert.

const Note = staticModel({ name: "UniqueNote", data: { text: f.string("") } });
const Live = model({ name: "UniqueLive", data: { text: f.string("") } });

describe.each([
  ["staticModel", Note],
  ["model", Live],
] as const)("%s", (_kind, Model: any) => {
  it("rejects a rebind onto an id another live instance holds", () => {
    const app = scope();
    const [a, b] = scoped(app, () => [Model.create({ id: "a" }), Model.create({ id: "b" })]);
    expect(() => a.rebind("b")).toThrow(
      `[models] rebind(): id "b" is already taken by a live ${Model.name} instance`,
    );
    expect([a.id, b.id]).toEqual(["a", "b"]);
    expect(scoped(app, () => collection(Model).get("a"))).toBe(a);
    expect(scoped(app, () => collection(Model).get("b"))).toBe(b);
    expect(scoped(app, () => Model.instances.ids)).toEqual(["a", "b"]);
  });

  it("allows a rebind onto the id of a disposed instance", async () => {
    const app = scope();
    const [a, b] = scoped(app, () => [Model.create({ id: "a" }), Model.create({ id: "b" })]);
    await b.dispose();
    a.rebind("b");
    expect(scoped(app, () => collection(Model).get("b"))).toBe(a);
    expect(scoped(app, () => Model.instances.ids)).toEqual(["b"]);
  });

  it("rejects an empty id in add() and rebind(), before a batch creates anything", () => {
    const app = scope();
    const a = scoped(app, () => Model.create({ id: "a" }));
    expect(() => a.rebind("")).toThrow("[models] rebind(): an id must be a non-empty string");
    expect(() => scoped(app, () => Model.create({ id: "" }))).toThrow(
      "[models] add(): an id must be a non-empty string",
    );
    expect(() => scoped(app, () => Model.create([{ id: "x" }, { id: "" }]))).toThrow(
      /non-empty string/,
    );
    expect(scoped(app, () => Model.instances.ids)).toEqual(["a"]);
    expect(a.id).toBe("a");
  });

  it("generates ids that skip ids supplied explicitly", () => {
    const app = scope();
    const probe = scoped(app, () => Model.create({}));
    const counter = Number(probe.id.slice(4));
    const taken = [counter + 1, counter + 2].map((n) => `~tmp${n}`);
    for (const id of taken) scoped(app, () => Model.create({ id }));
    const generated = scoped(app, () => Model.create({}));
    expect(taken).not.toContain(generated.id);
    const ids: string[] = scoped(app, () => Model.instances.ids);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(scoped(app, () => collection(Model).get(id))?.id).toBe(id);
  });

  it("keeps add() with an existing id an upsert", () => {
    const app = scope();
    const first = scoped(app, () => Model.create({ id: "a", text: "one" }));
    const second = scoped(app, () => Model.create({ id: "a", text: "two" }));
    expect(second).toBe(first);
    expect(first.text.value).toBe("two");
    expect(scoped(app, () => Model.instances.count)).toBe(1);
  });
});

it("rejects a creation whose dynamic setup took its id", () => {
  // Without data fields the instance owns no SID namespace that could collide
  // first: the id check itself must catch it.
  const app = scope();
  let inner: any;
  let nested = false;
  const Greedy: any = model({
    name: "UniqueGreedy",
    setup() {
      if (!nested) {
        nested = true;
        inner = Greedy.create({ id: "same" });
      }
      return {};
    },
  });
  expect(() => scoped(app, () => Greedy.create({ id: "same" }))).toThrow(
    '[models] add(): id "same" is already taken by a live UniqueGreedy instance',
  );
  expect(scoped(app, () => collection(Greedy).get("same"))).toBe(inner);
  expect(scoped(app, () => Greedy.instances.count)).toBe(1);
});

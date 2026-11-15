import { expect, it } from "vitest";
import { scope, scoped, serialize } from "@virentia/core";
import type { InstanceOf } from "@virentia/core/models";
import { h } from "@virentia/ui";
import { renderToString } from "@virentia/ui/server";
import { relationshipExample } from "../fixtures/model-relations";

it("hydrates children/refs/inverse and indexed queries, then keeps edits and cascade disposal scope-local", async () => {
  const example = relationshipExample(),
    server = scope();
  const ownedBy = (parent: object) => (row: InstanceOf<typeof example.Row>) =>
    "value" in row.parents && row.parents.value === parent;
  const original = scoped(server, () => example.Parent.create({ id: "parent" }));
  expect(original.rows.items.every(ownedBy(original))).toBe(true);
  const html = renderToString(() => h(example.View, { model: original }), { scope: server });
  const input = JSON.parse(JSON.stringify(original.json()));
  const snapshot = JSON.parse(JSON.stringify(serialize(server)));
  await original.dispose();
  const host = document.createElement("div"),
    otherHost = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host, otherHost);
  const serverRows = [...host.querySelectorAll("li")];
  const first = example.mount(host, { application: scope(snapshot), input, hydrate: true });
  const second = example.mount(otherHost);
  const labels = (target: Element) =>
    [...target.querySelectorAll("li")].map((row) => row.textContent);
  try {
    expect([...host.querySelectorAll("li")]).toEqual(serverRows);
    for (const [index, row] of [...host.querySelectorAll("li")].entries())
      expect(row).toBe(serverRows[index]);
    expect(labels(host)).toEqual(["first", "second"]);
    expect(host.querySelector("[data-chosen]")!.textContent).toBe("second");
    await first.model.add();
    expect(labels(host)).toEqual(["first", "second", "third"]);
    expect(host.querySelector("[data-query]")!.textContent).toBe("first,second");
    expect(first.rows().every(ownedBy(first.model))).toBe(true);
    await first.model.move();
    expect(labels(host)).toEqual(["third", "first", "second"]);
    await first.model.remove();
    expect(labels(host)).toEqual(["first", "second"]);
    expect(first.model.tags.count).toBe(1);
    await first.model.remove();
    expect(first.model.tags.count).toBe(0);
    await first.model.remove();
    expect(first.rows()).toEqual([]);
    expect(host.querySelector("[data-chosen]")!.textContent).toBe("");
    expect(labels(otherHost)).toEqual(["first", "second"]);
    expect(second.rows()).toHaveLength(2);
    expect(second.model.tags.count).toBe(1);
  } finally {
    await first.dispose();
    await second.dispose();
    expect(host.childNodes).toHaveLength(0);
    expect(otherHost.childNodes).toHaveLength(0);
    expect(first.model.alive).toBe(false);
    expect(second.model.alive).toBe(false);
    expect(first.rows()).toEqual([]);
    expect(second.rows()).toEqual([]);
    host.remove();
    otherHost.remove();
  }
  const reused = example.mount(host, { application: first.application });
  try {
    expect(reused.model).not.toBe(first.model);
    expect(reused.model.rows.items.every(ownedBy(reused.model))).toBe(true);
    expect(labels(host)).toEqual(["first", "second"]);
  } finally {
    await reused.dispose();
  }
});

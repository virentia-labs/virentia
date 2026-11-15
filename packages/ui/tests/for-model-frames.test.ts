import { resolveStoreSid } from "@virentia/core/internal";
import { f, staticModel } from "@virentia/core/models";
import { expect } from "vitest";
import { it } from "./support/vitest";
import { component, For, h } from "../lib";
import { contextualElementId } from "../lib/runtime";

it("mounts a model list row in its component's frame, as the row description did", async ({
  root,
}) => {
  const seen: string[] = [];
  const Item = staticModel({ data: { label: f.string("") } });
  const Inner = (props: { label: unknown }) => {
    seen.push(`inner ${resolveStoreSid("probe")} ${contextualElementId("inner")}`);
    return h("b", null, props.label as never);
  };
  const Row = component({
    model: Item,
    view: (_props, self) => {
      seen.push(`view ${resolveStoreSid("probe")}`);
      return h("li", null, h(Inner, { label: self.model.label }), () => {
        seen.push(`dynamic ${resolveStoreSid("probe")}`);
        return self.model.label.value;
      });
    },
  });
  root.run(() =>
    Item.create([
      { id: "a/b", label: "A" },
      { id: "c d", label: "C" },
    ]),
  );
  await root.render(() => h("ul", null, h(For, { each: Item, view: Row })));
  const d = root.run(() => Item.create({ id: "d", label: "D" }));
  d.label.value = "E";
  await root.run(() => Item.instances.remove("a/b"));
  expect(root.container.innerHTML).toBe(
    "<ul><!--ui--><li><b>C</b><!--ui-->C<!--/ui--></li><li><b>E</b><!--ui-->E<!--/ui--></li><!--/ui--></ul>",
  );
  // The frames of the component and of what it mounts, as a separate row frame
  // holding the component's frame named them.
  expect(seen).toEqual([
    "view ui:test.0.0.0.row:a%2Fb.0/probe",
    "inner ui:test.0.0.0.row:a%2Fb.0.0.item:0.0/probe ui:test:anonymous:0:a%2Fb:inner",
    "dynamic ui:test.0.0.0.row:a%2Fb.0.0.item:1.0/probe",
    "view ui:test.0.0.0.row:c%20d.0/probe",
    "inner ui:test.0.0.0.row:c%20d.0.0.item:0.0/probe ui:test:anonymous:0:c%20d:inner",
    "dynamic ui:test.0.0.0.row:c%20d.0.0.item:1.0/probe",
    "view ui:test.0.0.0.row:d.0/probe",
    "inner ui:test.0.0.0.row:d.0.0.item:0.0/probe ui:test:anonymous:0:d:inner",
    "dynamic ui:test.0.0.0.row:d.0.0.item:1.0/probe",
    "dynamic ui:test.0.0.0.row:d.0.0.item:1.0/probe",
  ]);
});

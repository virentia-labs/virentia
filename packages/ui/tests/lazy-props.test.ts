import { reaction } from "@virentia/core";
import { children, f, staticModel } from "@virentia/core/models";
import { describe, expect } from "vitest";
import { it } from "./support/vitest";
import { component, h, ui } from "../lib";

// A component's view props are a snapshot of its model, taken when they are
// first read. A view that never reads them builds no snapshot at all.

describe("component view props", () => {
  it("are the model's values at the first read, not at mount", async ({ root }) => {
    const seen: unknown[] = [];
    const Note = staticModel({
      name: "LazyPropsNote",
      with: [ui],
      data: { title: f.string("") },
      setup(self) {
        reaction({ on: self.unmounted, run: (event) => void seen.push(event.props.title) });
      },
    });
    const View = component({ model: Note, view: (_props, self) => h("p", null, self.model.title) });
    const note = root.run(() => Note.create({ id: "n", title: "first" }));
    await root.render(() => h(View, { model: note }));
    root.run(() => {
      note.title.value = "second";
    });
    expect(root.container.textContent).toBe("second");
    await root.render(() => null);
    expect(seen).toEqual(["second"]);
  });

  it("keep the snapshot of their first read", async ({ root }) => {
    let props: any;
    const Note = staticModel({ name: "LazyPropsStable", data: { title: f.string("") } });
    const View = component({
      model: Note,
      view: (current) => {
        props = current;
        return h("p", null, current.title);
      },
    });
    const note = root.run(() => Note.create({ id: "n", title: "first" }));
    await root.render(() => h(View, { model: note }));
    root.run(() => {
      note.title.value = "second";
    });
    expect(props.title).toBe("first");
    expect(props.id).toBe("n");
    expect(root.container.textContent).toBe("first");
  });

  it("take inputs that are no fields as given, without a snapshot at mount", async ({ root }) => {
    let props: any;
    let list: any;
    const Item = staticModel({ name: "LazyPropsItem", data: { label: f.string("") } });
    const List = staticModel({
      name: "LazyPropsList",
      data: { title: f.string(""), rows: children.many(Item) },
    });
    const View = component({
      model: List,
      view: (current, self) => {
        props = current;
        list = self.model;
        return h("p", null, self.model.title);
      },
    });
    const rows = [{ id: "a", label: "A" }];
    await root.render(() => h(View, { title: "first", rows, extra: "x" }));
    root.run(() => {
      list.title.value = "second";
    });
    // Taken at the first read, with the inputs as they were given.
    expect(props.title).toBe("second");
    expect(props.rows).toBe(rows);
    expect(props.extra).toBe("x");
    expect(Object.keys(props).sort()).toEqual(["extra", "id", "rows", "title"]);
  });

  it("read first inside a DOM binding make it depend on nothing", async ({ root }) => {
    let reads = 0;
    const Note = staticModel({ name: "LazyPropsUntracked", data: { title: f.string("") } });
    const View = component({
      model: Note,
      view: (current) =>
        h("p", null, () => {
          reads++;
          return current.title;
        }),
    });
    const note = root.run(() => Note.create({ id: "n", title: "first" }));
    await root.render(() => h(View, { model: note }));
    expect([reads, root.container.textContent]).toEqual([1, "first"]);
    root.run(() => {
      note.title.value = "second";
    });
    expect([reads, root.container.textContent]).toEqual([1, "first"]);
  });
});

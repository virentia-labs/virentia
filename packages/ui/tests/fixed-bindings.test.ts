import { computed, store } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { describe, expect } from "vitest";
import { it } from "./support/vitest";
import { component, h } from "../lib";

// Text and a lone class observe a unit through its one node: a store, a
// computed, a model field or a computed member. They update, stay isolated
// per scope and stop with their element like any other binding.

describe("bindings to one unit", () => {
  it("follow a computed member in text and in a class", async ({ root }) => {
    let evaluations = 0;
    const Row = staticModel({
      name: "FixedBindingsRow",
      data: { first: f.string(""), last: f.string(""), useLast: f.boolean(false) },
      setup(self) {
        return {
          display: computed(() => {
            evaluations++;
            return self.useLast.value ? self.last.value : self.first.value;
          }),
          tone: computed(() => (self.useLast.value ? "last" : "first")),
        };
      },
    });
    const View = component({
      model: Row,
      view: (_props, self) => h("p", { class: self.model.tone }, self.model.display),
    });
    const row = root.run(() => Row.create({ id: "r", first: "Ada", last: "Lovelace" }));
    await root.render(() => h(View, { model: row }));
    const p = root.container.querySelector("p")!;
    expect([p.className, p.textContent, evaluations]).toEqual(["first", "Ada", 1]);
    root.run(() => {
      row.last.value = "Byron";
    });
    // Not a dependency yet.
    expect([p.textContent, evaluations]).toEqual(["Ada", 1]);
    root.run(() => {
      row.useLast.value = true;
    });
    expect([p.className, p.textContent]).toEqual(["last", "Byron"]);
    root.run(() => {
      row.last.value = "King";
      row.first.value = "Augusta";
    });
    expect(p.textContent).toBe("King");
    await root.render(() => null);
    root.run(() => {
      row.last.value = "Gone";
    });
    expect(p.textContent).toBe("King");
  });

  it("follow stores and computeds in a lone class or className, and in text", async ({ root }) => {
    const tone = store("a");
    const upper = computed(() => tone.value.toUpperCase());
    await root.render(() =>
      h(
        "div",
        null,
        h("i", { class: tone }),
        h("b", { className: upper }, upper),
        h("s", { class: tone, classList: { on: true } }),
        h("q", { class: "x", className: upper }),
      ),
    );
    const html = () => root.container.innerHTML;
    expect(html()).toBe(
      '<div><i class="a"></i><b class="A">A</b><s class="a on"></s><q class="A"></q></div>',
    );
    root.run(() => {
      tone.value = "b";
    });
    expect(html()).toBe(
      '<div><i class="b"></i><b class="B">B</b><s class="b on"></s><q class="B"></q></div>',
    );
  });

  it("follow one unit in an attribute, from unset to set and back", async ({ root }) => {
    const title = store<string | undefined>(undefined);
    const href = computed(() => (title.value ? `#${title.value}` : undefined));
    await root.render(() => h("a", { title, href, "data-x": title }, "link"));
    const a = root.container.querySelector("a")!;
    expect(a.outerHTML).toBe("<a>link</a>");
    root.run(() => {
      title.value = "top";
    });
    // Units are patched as their writes propagate: the computed one last.
    expect(a.outerHTML).toBe('<a title="top" data-x="top" href="#top">link</a>');
    root.run(() => {
      title.value = undefined;
    });
    expect(a.outerHTML).toBe("<a>link</a>");
  });

  it("read a computed member through the instance that owns it", async ({ root }) => {
    const Row = staticModel({
      name: "FixedBindingsOwn",
      data: { count: f.number(0) },
      setup(self) {
        return { label: computed(() => `#${self.count.value}`) };
      },
    });
    const View = component({ model: Row, view: (_props, self) => h("b", null, self.model.label) });
    const [a, b] = root.run(() => [
      Row.create({ id: "a", count: 1 }),
      Row.create({ id: "b", count: 2 }),
    ]);
    await root.render(() => [h(View, { model: a, key: "a" }), h(View, { model: b, key: "b" })]);
    expect(root.container.textContent).toBe("#1#2");
    root.run(() => {
      b.count.value = 5;
    });
    expect(root.container.textContent).toBe("#1#5");
  });
});

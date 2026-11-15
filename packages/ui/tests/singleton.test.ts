import { expect, describe, test } from "vitest";
import { computed, reaction, scope, scoped, serialize } from "@virentia/core";
import { f, model, staticModel } from "@virentia/core/models";
import { For, action, component, h, hydrate, ref, render, ui } from "../lib";
import { renderToString } from "../lib/server";
import { mutableStore } from "@virentia/mutable";

for (const define of [model, staticModel]) {
  describe(`${define.name}.static in native UI`, () => {
    const Model = define({
      name: "SingletonUI",
      with: [ui],
      data: { count: f.number(0) },
      setup(self) {
        const input = ref<HTMLInputElement>();
        const add = action(() => {
          self.count.value++;
        });
        reaction({ on: self.mounted, run: () => input.value?.focus() });
        return { input, add };
      },
    });
    const Singleton = Model.static();
    const View = component({
      model: Model,
      view(_props, self) {
        return h(
          "div",
          null,
          h("input", { ref: self.model.input }),
          h("button", { onClick: self.model.add }, self.model.count),
        );
      },
    });

    test.concurrent.each([2, 7])(
      "shares the singleton graph but isolates scope %s and DOM",
      async (initial) => {
        const app = scope({ values: [[Singleton.count, initial]] });
        const page = document.implementation.createHTMLDocument("singleton");
        const container = page.createElement("div");
        page.body.append(container);
        const stop = render(() => h(View, { model: Singleton }), container, { scope: app });
        try {
          const button = container.querySelector("button")!;
          expect(button.textContent).toBe(String(initial));
          await scoped(app, () => Singleton.add());
          expect(container.querySelector("button")).toBe(button);
          expect(button.textContent).toBe(String(initial + 1));
          expect(scoped(app, () => Singleton.input.value)).toBe(container.querySelector("input"));
          await stop();
          expect(scoped(app, () => Singleton.input.value)).toBeNull();
          expect(scoped(app, () => Singleton.count.value)).toBe(initial + 1);
        } finally {
          await stop();
        }
      },
    );

    test("keeps SSR addresses and adopts existing DOM during hydration", async () => {
      const server = scope({ values: [[Singleton.count, 5]] });
      const html = renderToString(() => h(View, { model: Singleton }), { scope: server });
      const client = scope({ snapshot: serialize(server) });
      const container = document.createElement("div");
      container.innerHTML = html;
      const before = container.querySelector("button");
      const stop = hydrate(() => h(View, { model: Singleton }), container, { scope: client });
      try {
        expect(container.querySelector("button")).toBe(before);
        expect(before?.textContent).toBe("5");
        await scoped(client, () => Singleton.add());
        expect(container.querySelector("button")).toBe(before);
        expect(before?.textContent).toBe("6");
      } finally {
        await stop();
      }
    });

    test("renders two independent .static() models in the same scope", async () => {
      const first = Model.static();
      const second = Model.static();
      const app = scope({
        values: [
          [first.count, 2],
          [second.count, 7],
        ],
      });
      const container = document.createElement("div");
      const stop = render(
        () => [h(View, { model: first }), h(View, { model: second })],
        container,
        { scope: app },
      );
      try {
        const [left, right] = container.querySelectorAll("button");
        expect(left.textContent).toBe("2");
        expect(right.textContent).toBe("7");
        await scoped(app, () => first.add());
        expect(container.querySelector("button")).toBe(left);
        expect(left.textContent).toBe("3");
        expect(right.textContent).toBe("7");
        expect(scoped(app, () => first.input.value)).not.toBe(
          scoped(app, () => second.input.value),
        );
      } finally {
        await stop();
      }
    });
  });
}

test("singleton mutable arrays keep native operation streams and cross-model reads", async () => {
  const Model = model({
    setup() {
      return { items: mutableStore([{ label: "A" }]) };
    },
  });
  const Singleton = Model.static();
  const RowModel = staticModel({ data: { label: f.string() } });
  const Row = component({
    model: RowModel,
    view: (_props, self) => h("p", null, self.model.label),
  });
  const ParentModel = staticModel({
    setup() {
      return { count: computed(() => Singleton.items.value.length) };
    },
  });
  const Parent = component({
    model: ParentModel,
    view: (_props, self) =>
      h(
        "section",
        null,
        h("strong", null, self.model.count),
        h(For, { each: Singleton.items, view: Row }),
      ),
  });
  const app = scope();
  const parent = scoped(app, () => ParentModel.create({}));
  const container = document.createElement("div");
  const stop = render(() => h(Parent, { model: parent }), container, { scope: app });
  try {
    const first = container.querySelector("p");
    scoped(app, () => Singleton.items.value.push({ label: "B" }));
    expect(container.querySelector("p")).toBe(first);
    expect(container.querySelector("strong")?.textContent).toBe("2");
    expect(parent.count.value).toBe(2);
    expect(container.textContent).toBe("2AB");
    expect(scoped(scope(), () => Singleton.items.value.length)).toBe(1);
  } finally {
    await stop();
  }
  await scoped(app, () => Singleton.dispose());
  expect(scoped(app, () => Singleton.items.value.length)).toBe(1);
});

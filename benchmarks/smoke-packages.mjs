import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Window } from "../packages/ui/node_modules/happy-dom/lib/index.js";

const require = createRequire(import.meta.url);
async function load(mode, name, entry = "index") {
  const file = `../packages/${name}/dist/${entry}.${mode === "esm" ? "mjs" : "cjs"}`;
  return mode === "esm" ? import(new URL(file, import.meta.url)) : require(file);
}
for (const mode of ["esm", "cjs"]) {
  const core = await load(mode, "core");
  const { staticModel, f } = await load(mode, "core", "models");
  const ui = await load(mode, "ui");
  const server = await load(mode, "ui", "server");
  const jsx = await load(mode, "ui", "jsx-runtime");
  assert.equal(typeof jsx.jsx, "function");
  const Model = staticModel({
    name: `PackageSmoke-${mode}`,
    data: { count: f.number(0) },
    setup(self) {
      const increment = core.event();
      core.reaction({
        on: increment,
        run() {
          self.count.value++;
        },
      });
      return { increment };
    },
  });
  const first = core.scope(),
    second = core.scope();
  const a = core.scoped(first, () => Model.create({ id: "row" }));
  const b = core.scoped(second, () => Model.create({ id: "row", count: 9 }));
  let views = 0;
  const View = ui.component({
    model: Model,
    view(_props, self) {
      views++;
      return ui.h("p", { "data-id": self.id }, self.model.count);
    },
  });
  const window = new Window();
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const dispose = ui.render(() => ui.h(View, { model: a }), container, { scope: first });
  const text = container.querySelector("p").firstChild;
  assert.equal(text.textContent, "0");
  await a.increment();
  assert.equal(text.textContent, "1");
  assert.equal(container.querySelector("p").firstChild, text);
  assert.equal(views, 1);
  assert.equal(b.count.value, 9);
  await dispose();
  assert.equal(container.childNodes.length, 0);
  await a.increment();
  assert.equal(text.textContent, "1");
  const snapshot = core.serialize(first);
  const restored = core.scope({ snapshot });
  const copy = core.scoped(restored, () => Model.create({ id: "row", count: 0 }));
  assert.equal(copy.count.value, 2);
  const html = server.renderToString(() => ui.h(View, { model: copy }), { scope: restored });
  const parsed = window.document.createElement("div");
  parsed.innerHTML = html;
  assert.equal(parsed.querySelector("p").textContent, "2");
  for (const name of ["react", "vue", "mutable", "effector", "inspector"]) {
    assert(Object.keys(await load(mode, name)).length > 0, `${mode}: missing ${name} exports`);
  }
  await Promise.all([a.dispose(), b.dispose(), copy.dispose()]);
  await window.happyDOM.close();
  console.log(`Passed: ${mode} built package imports, in-place DOM, scopes and SSR snapshot`);
}

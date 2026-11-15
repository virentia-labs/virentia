import { h as vh, render as vrender, scope, scoped, store, component, For } from "@virentia/ui";
import { jsx, jsxs } from "@virentia/ui/jsx-runtime";
import { f, staticModel } from "@virentia/core/models";
import { getInspectorSnapshot } from "../packages/core/lib/kernel/inspector";
import { createElement as rh, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { jsx as rjsx, jsxs as rjsxs } from "react/jsx-runtime";
import { createApp, defineComponent, h, nextTick, shallowRef } from "vue";
import { domModelPrototypeStats } from "./dom-model-prototype";

if (process.env.VIRENTIA_BENCH_DOM_MODEL === "1")
  Object.assign(globalThis, { auditDOMModelStats: domModelPrototypeStats });

// Validated build-time numeric literals; default workload remains 1000/10/25.
declare const VIRENTIA_BENCH_ROWS: number;
declare const VIRENTIA_BENCH_STRIDE: number;
const n = VIRENTIA_BENCH_ROWS,
  stride = VIRENTIA_BENCH_STRIDE,
  batches = 25;
type Mounted = { update(value: number): Promise<void>; dispose(): void | Promise<void> };
const host = document.getElementById("host")!;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const assert = (condition: boolean, message: string) => {
  if (!condition) throw Error(message);
};

function mountVirentia(container: HTMLElement): Mounted {
  const app = scope();
  const values: ReturnType<typeof store<number>>[] = [];
  const Row = component({
    model: staticModel({
      name: process.env.VIRENTIA_BENCH_NAMED_MODEL === "1" ? "BenchUIRow" : undefined,
      data: { count: f.number(0) },
    }),
    view(_props, self) {
      const id = self.id;
      values[Number(id)] = self.model.count;
      if (process.env.VIRENTIA_BENCH_JSX === "1")
        return jsxs("tr", {
          "data-row": id,
          children: [
            jsx("td", { children: String(id) }),
            jsx("td", { children: self.model.count }),
          ],
        });
      return vh(
        "tr",
        { "data-row": id },
        vh("td", null, String(id)),
        vh("td", null, self.model.count),
      );
    },
  });
  const dispose = vrender(
    () =>
      process.env.VIRENTIA_BENCH_JSX === "1"
        ? jsx("table", {
            children: jsx("tbody", {
              children: Array.from({ length: n }, (_, id) => jsx(Row, { id: String(id) }, id)),
            }),
          })
        : vh(
            "table",
            null,
            vh(
              "tbody",
              null,
              Array.from({ length: n }, (_, id) => vh(Row, { id: String(id), key: id })),
            ),
          ),
    container,
    { scope: app },
  );
  return {
    async update(value) {
      scoped(app, () => {
        for (let i = 0; i < n; i += stride) values[i].value = value;
      });
    },
    dispose,
  };
}

// Supplemental ownership-registry workload, not a substitute for modeled rows.
function mountStaticVirentia(container: HTMLElement) {
  return vrender(
    () =>
      vh(
        "main",
        null,
        Array.from({ length: 5000 }, (_, id) => vh("p", null, String(id))),
      ),
    container,
    { scope: scope() },
  );
}

// Supplemental native-container workload; original modeled-row timers are unchanged.
function mountForVirentia(container: HTMLElement) {
  const app = scope();
  const Model = staticModel({ data: { count: f.number(0) } });
  const Row = component({ model: Model, view: (_props, self) => vh("p", null, self.model.count) });
  scoped(app, () => {
    for (let id = 0; id < n; id++) Model.create({ id: String(id) });
  });
  const dispose = vrender(() => vh(For, { each: Model, view: Row }), container, { scope: app });
  return {
    dispose,
    async verify() {
      const rows = [...container.querySelectorAll("p")];
      assert(rows.length === n && rows.every((row) => row.textContent === "0"), "Wrong For rows");
      scoped(app, () => {
        Model.get("0")!.count.value = 1;
      });
      assert(
        rows[0].textContent === "1" && container.querySelector("p") === rows[0],
        "For replaced text",
      );
      const extra = scoped(app, () => Model.create({ id: "extra", count: 2 }));
      assert(container.querySelectorAll("p").length === n + 1, "For missed insertion");
      await extra.dispose();
      assert(container.querySelectorAll("p").length === n, "For missed removal");
      assert(
        [...container.querySelectorAll("p")].every((row, index) => row === rows[index]),
        "For replaced existing rows",
      );
    },
  };
}

async function mountReact(container: HTMLElement): Promise<Mounted> {
  const root = createRoot(container);
  const setters: Array<(value: number) => void> = [];
  let commit: (() => void) | undefined;
  let remaining = 0;
  const committed = () =>
    new Promise<void>((resolve) => {
      commit = resolve;
    });
  function Row({ id }: { id: number }) {
    const [value, set] = useState(0);
    setters[id] = set;
    useLayoutEffect(() => {
      if (--remaining === 0) commit?.();
    });
    return rh("tr", { "data-row": id }, rh("td", null, String(id)), rh("td", null, value));
  }
  const mounted = committed();
  remaining = n;
  root.render(
    rh(
      "table",
      null,
      rh(
        "tbody",
        null,
        Array.from({ length: n }, (_, id) => rh(Row, { id, key: id })),
      ),
    ),
  );
  await mounted;
  return {
    async update(value) {
      const updated = committed();
      remaining = n / stride;
      for (let i = 0; i < n; i += stride) setters[i](value);
      await updated;
    },
    dispose() {
      root.unmount();
    },
  };
}

// Diagnostic control: no per-row commit-acknowledgement effect, synchronous
// public React API. Keep the original default-priority React case unchanged.
function mountReactSync(container: HTMLElement): Mounted {
  const root = createRoot(container);
  const setters: Array<(value: number) => void> = [];
  function Row({ id }: { id: number }) {
    const [value, set] = useState(0);
    setters[id] = set;
    if (process.env.VIRENTIA_BENCH_REACT_JSX === "1")
      return rjsxs("tr", { "data-row": id, children: [
        rjsx("td", { children: String(id) }), rjsx("td", { children: value }),
      ] });
    return rh("tr", { "data-row": id }, rh("td", null, String(id)), rh("td", null, value));
  }
  flushSync(() => root.render(process.env.VIRENTIA_BENCH_REACT_JSX === "1"
    ? rjsx("table", { children: rjsx("tbody", {
      children: Array.from({ length: n }, (_, id) => rjsx(Row, { id }, id)),
    }) })
    : rh("table", null, rh("tbody", null,
      Array.from({ length: n }, (_, id) => rh(Row, { id, key: id })),
    ))));
  return {
    async update(value) {
      flushSync(() => {
        for (let id = 0; id < n; id += stride) setters[id](value);
      });
    },
    dispose() { root.unmount(); },
  };
}

function mountVue(container: HTMLElement): Mounted {
  const values: ReturnType<typeof shallowRef<number>>[] = [];
  const Row = defineComponent({
    props: { id: { type: Number, required: true } },
    setup(props) {
      const value = shallowRef(0);
      values[props.id] = value;
      return () =>
        h("tr", { "data-row": props.id }, [h("td", String(props.id)), h("td", value.value)]);
    },
  });
  const app = createApp({
    render: () =>
      h("table", null, [
        h(
          "tbody",
          null,
          Array.from({ length: n }, (_, id) => h(Row, { id, key: id })),
        ),
      ]),
  });
  app.mount(container);
  return {
    async update(value) {
      for (let i = 0; i < n; i += stride) values[i].value = value;
      await nextTick();
    },
    dispose() {
      app.unmount();
    },
  };
}

function validate(container: HTMLElement, value: number) {
  const rows = container.querySelectorAll("tr");
  assert(rows.length === n, `Wrong row count: ${rows.length}`);
  rows.forEach((row, id) => {
    assert(row.cells[0].textContent === String(id), `Wrong id at ${id}`);
    assert(
      row.cells[1].textContent === String(id % stride === 0 ? value : 0),
      `Wrong value at ${id}`,
    );
  });
}

async function sample(variant: string, round: number) {
  const container = document.createElement("div");
  host.append(container);
  await frame();
  const start = performance.now();
  const mounted =
    variant === "virentia"
      ? mountVirentia(container)
      : variant === "react"
        ? await mountReact(container)
        : mountVue(container);
  const mountMs = performance.now() - start;
  validate(container, 0);
  // A warm update ensures each framework has an established update path.
  await mounted.update(1);
  validate(container, 1);
  let updateMs = 0;
  const batchMs: number[] = [];
  for (let i = 0; i < batches; i++) {
    await frame();
    const t = performance.now();
    await mounted.update(i + 2);
    const elapsed = performance.now() - t;
    updateMs += elapsed;
    batchMs.push(elapsed);
    validate(container, i + 2);
  }
  const checksum = Array.from(container.querySelectorAll("tr")).reduce(
    (sum, row) => sum + Number(row.cells[1].textContent),
    0,
  );
  assert(checksum === (n / stride) * (batches + 1), "Checksum mismatch");
  await mounted.dispose();
  container.remove();
  assert(host.childElementCount === 0, "Root leaked");
  return { variant, round, n, stride, batches, mountMs, updateMs, batchMs, checksum };
}

Object.assign(globalThis, {
  auditWorkload: { rows: n, stride, batches, updatesPerBatch: n / stride,
    reactSyncSyntax: process.env.VIRENTIA_BENCH_REACT_JSX === "1" ? "jsx" : "createElement" },
  auditMounts: { virentia: mountVirentia, react: mountReact, vue: mountVue, "react-sync": mountReactSync },
  auditScaleSample: scaleSample,
  auditSample: sample,
  auditMount: mountVirentia,
  auditStaticMount: mountStaticVirentia,
  auditForMount: mountForVirentia,
  auditInspector: () => {
    const s = getInspectorSnapshot();
    return { nodes: s.nodes.length, scopes: s.scopes.length };
  },
});

// Supplemental scaling scenario: validation runs only after all timed work.
// Force layout separately from commit, and retain frame waits only in wallMs.
async function scaleSample(variant: string, round: number) {
  const container = document.createElement("div");
  host.append(container);
  await frame();
  const start = performance.now();
  const mounted = variant === "virentia" ? mountVirentia(container)
    : variant === "react" ? await mountReact(container)
    : variant === "react-sync" ? mountReactSync(container) : mountVue(container);
  const mountMs = performance.now() - start;
  container.getBoundingClientRect();
  const mountAndLayoutMs = performance.now() - start;
  const batchMs: number[] = [];
  const batchAndLayoutMs: number[] = [];
  for (let index = 1; index <= batches; index++) {
    await frame();
    const before = performance.now();
    await mounted.update(index);
    batchMs.push(performance.now() - before);
    container.getBoundingClientRect();
    batchAndLayoutMs.push(performance.now() - before);
  }
  const wallMs = performance.now() - start;
  validate(container, batches);
  const checksum = Array.from(container.querySelectorAll("tr")).reduce(
    (sum, row) => sum + Number(row.cells[1].textContent), 0,
  );
  assert(checksum === (n / stride) * batches, "Scaling checksum mismatch");
  const beforeDispose = performance.now();
  await mounted.dispose();
  const unmountMs = performance.now() - beforeDispose;
  assert(container.childNodes.length === 0, "Scaling unmount leaked nodes");
  container.remove();
  assert(host.childElementCount === 0, "Scaling root leaked");
  const updateMs = batchMs.reduce((sum, value) => sum + value, 0);
  const updateAndLayoutMs = batchAndLayoutMs.reduce((sum, value) => sum + value, 0);
  return { variant, round, n, stride, batches, updatesPerBatch: n / stride,
    mountMs, mountAndLayoutMs, updateMs, updateAndLayoutMs,
    totalMs: mountMs + updateMs, totalAndLayoutMs: mountAndLayoutMs + updateAndLayoutMs,
    wallMs, unmountMs, batchMs, batchAndLayoutMs, checksum };
}

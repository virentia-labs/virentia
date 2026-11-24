import { reaction, scope, scoped, serialize, store, type Scope, type StoreWritable } from "@virentia/core";
import { children, staticModel } from "@virentia/core/models";
import { createField, createForm, readStoreSnapshot } from "@virentia/forms";
import { fieldModel } from "@virentia/forms/models";
import { formToEffector } from "@virentia/forms-effector";
import { associate } from "@virentia/effector";
import { allSettled, fork } from "effector";
import { memory, persist, type StorageBox } from "@virentia/storage-core";
import { query } from "@virentia/net-core";
import { route, router, historyAdapter } from "@virentia/router";
import { render, type ComponentProps } from "@virentia/ui";
import { jsx, type JSX } from "@virentia/ui/jsx-runtime";
import { ScopeProvider } from "@virentia/react";
import { useField, useForm } from "@virentia/forms-react";
import { useQuery as useReactQuery } from "@virentia/net-react";
import { RouterProvider, useIsOpened, useLink, useRouter } from "@virentia/router-react";
import { provideScope, useUnit as useVueUnit } from "@virentia/vue";
import { useQuery as useVueQuery } from "@virentia/net-vue";
import { createMemoryHistory } from "history";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { createApp, defineComponent, h, nextTick } from "vue";
import { expect, expectTypeOf, it, vi } from "vitest";

const Editor = staticModel({
  name: "EcosystemEditor",
  setup() {
    const form = createForm({ schema: { name: createField("") } });
    const draft = store("", undefined, { sid: "ecosystem/draft" });
    const page = route({ path: "/edit/:id" });
    const navigation = router({ routes: [page] });
    const remote = query({ handler: async (id: string) => ({ name: `user:${id}` }) });
    reaction({ on: page.opened, async run(payload, { scope: app }) {
      const data = await remote(payload.params!.id);
      await scoped(app, () => form.fill({ values: data }));
    } });
    reaction({ on: form.changed, run(values) { draft.value = values.name; } });
    return {
      form, draft, page, navigation, remote,
      connect(storage: StorageBox) {
        return persist({ source: draft, key: "draft", storage });
      },
    };
  },
});

function moduleEditor() {
  // Keep the existing application-scoped module API covered as well as .create().
  return Editor.static();
}

const PersistenceBinding = staticModel({
  setup() {
    return {
      connect(source: StoreWritable<string>, storage: StorageBox, app: Scope) {
        return persist({ source, key: "draft", storage, scope: app });
      },
    };
  },
});

it("runs router → net → form → storage → UI independently in two applications", async () => {
  expectTypeOf<JSX.IntrinsicElements["p"]>().toEqualTypeOf<ComponentProps<"p">>();
  const model = moduleEditor();
  const a = scope(), b = scope();
  const boxA = memory(), boxB = memory();
  const bindingA = scoped(a, () => PersistenceBinding.create({ id: "draft" }));
  const bindingB = scoped(b, () => PersistenceBinding.create({ id: "draft" }));
  const stopA = bindingA.connect(model.draft, boxA, a);
  bindingB.connect(model.draft, boxB, b);
  const host = document.createElement("main");
  document.body.append(host);
  const detach = render(() => jsx("p", { children: model.form.fields.name.state }), host, { scope: a });
  try {
    await scoped(a, () => model.navigation.setHistory(historyAdapter(createMemoryHistory())));
    await scoped(b, () => model.navigation.setHistory(historyAdapter(createMemoryHistory())));
    await scoped(a, () => model.page.open({ params: { id: "a" } }));
    await vi.waitFor(() => expect(host.textContent).toBe("user:a"));
    expect(boxA.get("draft")).toBe("user:a");
    expect(boxB.get("draft")).toBe("");
    expect(scoped(b, () => model.page.isOpened.value)).toBe(false);
    await scoped(b, () => model.page.open({ params: { id: "b" } }));
    await vi.waitFor(() => expect(scoped(b, () => model.form.fields.name.state.value)).toBe("user:b"));
    expect(scoped(a, () => model.remote.data.value)).toEqual({ name: "user:a" });
    expect(scoped(b, () => readStoreSnapshot(model.form.values))).toEqual({ name: "user:b" });
    expect(boxB.get("draft")).toBe("user:b");
    expect(host.textContent).toBe("user:a");
    const snapshot = serialize(a);
    const draftSid = Object.keys(snapshot).find(sid => sid.endsWith("/ecosystem/draft"));
    expect(draftSid).toBeDefined();
    expect(snapshot[draftSid!]).toBe("user:a");
    stopA();
    await bindingA.dispose();
    await scoped(a, () => model.form.fill({ values: { name: "local" } }));
    expect(host.textContent).toBe("local");
    expect(boxA.get("draft")).toBe("user:a");
    await detach();
    await scoped(a, () => model.form.fill({ values: { name: "after unmount" } }));
    expect(host.childNodes).toHaveLength(0);
  } finally {
    await detach();
    await bindingA.dispose(); await bindingB.dispose();
    await scoped(a, () => model.navigation.dispose());
    await scoped(b, () => model.navigation.dispose());
    await scoped(a, () => model.dispose());
    await scoped(b, () => model.dispose());
    host.remove();
  }
});

it("runs the complete graph in staticModel instances and reuses a disposed identity", async () => {
  const app = scope(), other = scope();
  const a = scoped(app, () => Editor.create({ id: "same" }));
  const b = scoped(app, () => Editor.create({ id: "sibling" }));
  const c = scoped(other, () => Editor.create({ id: "same" }));
  const boxA = memory(), boxB = memory(), boxC = memory();
  const host = document.createElement("main"); document.body.append(host);
  const detach = render(() => jsx("p", { children: a.form.fields.name.state }), host, { scope: app });
  try {
    a.connect(boxA); b.connect(boxB); c.connect(boxC);
    expect(a.form.fields.name.state.node).toBe(b.form.fields.name.state.node);
    for (const model of [a, b, c]) {
      await model.navigation.setHistory(historyAdapter(createMemoryHistory()));
      expect(model.navigation.path.value).toBe("/");
    }
    await a.page.open({ params: { id: "first" } });
    await b.page.open({ params: { id: "second" } });
    await c.page.open({ params: { id: "other app" } });
    await vi.waitFor(() => {
      expect([a.form.fields.name.state.value, b.form.fields.name.state.value, c.form.fields.name.state.value]).toEqual(["user:first", "user:second", "user:other app"]);
    });
    expect([a.page.isOpened.value, b.page.isOpened.value, c.page.isOpened.value]).toEqual([true, true, true]);
    expect(host.textContent).toBe("user:first");
    expect([boxA.get("draft"), boxB.get("draft"), boxC.get("draft")]).toEqual(["user:first", "user:second", "user:other app"]);
    expect(a.remote.data.value).toEqual({ name: "user:first" });

    await detach();
    await a.dispose();
    const reused = scoped(app, () => Editor.create({ id: "same" }));
    try {
      expect(reused.form.fields.name.state.value).toBe("");
      expect(reused.remote.data.value).toBeNull();
      boxA.set("draft", "old binding");
      expect(reused.draft.value).toBe("");
      await b.form.fill({ values: { name: "still live" } });
      expect(boxB.get("draft")).toBe("still live");
      expect(c.form.fields.name.state.value).toBe("user:other app");
    } finally { await reused.dispose(); }
  } finally {
    await detach();
    for (const model of [a, b, c]) {
      if (model.alive) await model.dispose();
    }
    host.remove();
  }
});

it("restores serialized Core state before binding storage and filling a form", async () => {
  const source = store("", undefined, { sid: "ecosystem/restore" });
  const original = scope();
  scoped(original, () => { source.value = "saved"; });
  const restored = scope({ snapshot: serialize(original) });
  const form = createForm({ schema: { name: createField("") } });
  const box = memory();
  const stop = persist({ source, key: "name", storage: box, scope: restored });
  try {
    await scoped(restored, () => form.fill({ values: { name: source.value } }));
    expect(box.get("name")).toBe("saved");
    expect(scoped(restored, () => form.fields.name.state.value)).toBe("saved");
    expect(scoped(original, () => form.fields.name.state.value)).toBe("");
  } finally { stop(); }
});

it("updates owned Field models through router, net, storage, React, Vue and Effector", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const Name = fieldModel("", { name: "OwnedEcosystemName" });
  const Draft = staticModel({
    name: "OwnedEcosystemDraft", data: { displayName: children.one(Name) },
    setup(self) {
      const form = createForm({ schema: () => ({ name: self.displayName.value!.field }) });
      const remote = query({ handler: async (id: string) => ({ name: `owned:${id}` }) });
      const page = route({ path: "/owned/:id" }), navigation = router({ routes: [page] });
      reaction({ on: page.opened, async run(payload) { await form.fill({ values: await remote(payload.params!.id) }); } });
      return { form, remote, page, navigation, connect(box: StorageBox) {
        return persist({ source: self.displayName.value!.value, key: "name", storage: box });
      } };
    },
    onCreate(self) { if (!self.displayName.value) self.displayName.create({}); },
  });
  const app = scope(), [a, b] = scoped(app, () => Draft.create([{}, {}]));
  const ef = fork(); associate({ virentia: app, effector: ef });
  const [ea, eb] = scoped(app, () => [formToEffector(a.form), formToEffector(b.form)]);
  const first = memory(), second = memory(); a.connect(first); b.connect(second);
  const reactHost = document.createElement("main"), vueHost = document.createElement("main");
  document.body.append(reactHost, vueHost);
  const reactRoot = createRoot(reactHost);
  function ReactView() {
    const link = useLink(a.page, { id: "target" });
    expect(link.path).toBe("/owned/target");
    const field = useField(a.form.fields.name), form = useForm(a.form), remote = useReactQuery(a.remote);
    return createElement("p", null, `${field.value}|${(form.values as { name: string }).name}|${remote.data?.name ?? "idle"}`);
  }
  const VueView = defineComponent({ setup() {
    const name = useVueUnit(b.form.fields.name.state), remote = useVueQuery(b.remote);
    return () => h("p", `${name.value}|${remote.data.value?.name ?? "idle"}`);
  } });
  const vueApp = createApp(defineComponent({ setup() { provideScope(app); return () => h(VueView); } }));
  try {
    await act(async () => reactRoot.render(createElement(ScopeProvider, { scope: app },
      createElement(RouterProvider, { router: a.navigation }, createElement(ReactView)))));
    vueApp.mount(vueHost);
    await a.navigation.setHistory(historyAdapter(createMemoryHistory()));
    await b.navigation.setHistory(historyAdapter(createMemoryHistory()));
    await act(async () => { await a.page.open({ params: { id: "react" } }); });
    await b.page.open({ params: { id: "vue" } }); await nextTick();
    await vi.waitFor(() => {
      expect(reactHost.textContent).toBe("owned:react|owned:react|owned:react");
      expect(vueHost.textContent).toBe("owned:vue|owned:vue");
    });
    expect([first.get("name"), second.get("name")]).toEqual(["owned:react", "owned:vue"]);
    await act(async () => { first.set("name", "external"); });
    expect(reactHost.textContent).toBe("external|external|owned:react");
    expect(b.form.fields.name.state.value).toBe("owned:vue");
    expect(ef.getState(ea.$values)).toEqual({ name: "external" });
    expect(ef.getState(eb.$values)).toEqual({ name: "owned:vue" });
    await act(async () => { await allSettled(ea.fill, { scope: ef, params: { values: { name: "effector" } } }); });
    expect(reactHost.textContent).toBe("effector|effector|owned:react");
    expect(first.get("name")).toBe("effector");
    expect(b.form.fields.name.state.value).toBe("owned:vue");
    const dto = a.json(), snapshot = serialize(app), restored = scoped(scope({ snapshot }), () => Draft.create(dto));
    try {
      expect(restored.form.values.value).toEqual({ name: "effector" });
      await restored.form.reset();
      expect(restored.form.values.value).toEqual({ name: "" });
      expect(a.form.values.value).toEqual({ name: "effector" });
    } finally { await restored.dispose(); }
  } finally {
    await act(async () => reactRoot.unmount()); vueApp.unmount();
    await a.dispose(); await b.dispose(); reactHost.remove(); vueHost.remove();
  }
});

it("uses one React scope across Forms, Net and Router providers and hooks", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const model = moduleEditor(), app = scope();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let fill!: ReturnType<typeof useForm> ["fill"];
  let load!: (id: string) => Promise<{ name: string }>;
  function View() {
    const form = useForm(model.form), remote = useReactQuery(model.remote);
    const opened = useIsOpened(model.page);
    expect(useRouter()).toBe(model.navigation);
    fill = form.fill; load = remote.run;
    return createElement("p", null, `${JSON.stringify(form.values)}|${remote.data?.name ?? "idle"}|${opened}`);
  }
  try {
    await scoped(app, () => model.navigation.setHistory(historyAdapter(createMemoryHistory())));
    await act(async () => root.render(createElement(ScopeProvider, { scope: app },
      createElement(RouterProvider, { router: model.navigation }, createElement(View)))));
    await act(async () => { await fill({ values: { name: "react" } }); await load("hook"); });
    expect(host.textContent).toBe('{"name":"react"}|user:hook|false');
    await act(async () => { await scoped(app, () => model.page.open({ params: { id: "route" } })); });
    expect(host.textContent).toBe('{"name":"user:route"}|user:route|true');
  } finally {
    await act(async () => root.unmount());
    await scoped(app, () => model.navigation.dispose());
    await scoped(app, () => model.dispose()); host.remove();
  }
});

it("uses one Vue scope for Net and stores produced by Forms and Router", async () => {
  const model = moduleEditor(), app = scope();
  let load!: (id: string) => Promise<{ name: string }>;
  const Child = defineComponent({ setup() {
    const remote = useVueQuery(model.remote);
    const values = useVueUnit(model.form.values), opened = useVueUnit(model.page.isOpened);
    load = remote.run;
    return () => h("p", `${JSON.stringify(values.value)}|${remote.data.value?.name ?? "idle"}|${opened.value}`);
  } });
  const vue = createApp(defineComponent({ setup() { provideScope(app); return () => h(Child); } }));
  const host = document.createElement("div"); document.body.append(host);
  try {
    await scoped(app, () => model.navigation.setHistory(historyAdapter(createMemoryHistory())));
    vue.mount(host);
    await load("vue");
    await scoped(app, () => model.form.fill({ values: { name: "vue form" } }));
    await nextTick();
    expect(host.textContent).toBe('{"name":"vue form"}|user:vue|false');
    await scoped(app, () => model.page.open({ params: { id: "vue route" } }));
    await vi.waitFor(() => expect(host.textContent).toBe('{"name":"user:vue route"}|user:vue route|true'));
  } finally {
    vue.unmount();
    await scoped(app, () => model.navigation.dispose());
    await scoped(app, () => model.dispose()); host.remove();
  }
});

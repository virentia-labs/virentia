import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createMemoryHistory } from "history";
import { allSettled, fork } from "effector";
import { expect, it, vi } from "vitest";
import { reaction, scope, scoped } from "@virentia/core";
import { children, staticModel } from "@virentia/core/models";
import { createForm } from "@virentia/forms";
import { arrayFieldModel, fieldModel, shapeFieldModel } from "@virentia/forms/models";
import { useField } from "@virentia/forms-react";
import { formToEffector } from "@virentia/forms-effector";
import { associate } from "@virentia/effector";
import { ScopeProvider } from "@virentia/react";
import { provideScope, useUnit } from "@virentia/vue";
import { memory, persist, type StorageBox } from "@virentia/storage-core";
import { query } from "@virentia/net-core";
import { route, router, historyAdapter } from "@virentia/router";

it("connects owned array/shape fields to Net, Router, Storage, React, Vue and Effector", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const Email = fieldModel("", { name: "AllPackagesEmail" });
  const Phones = arrayFieldModel([""], { name: "AllPackagesPhones" });
  const Details = shapeFieldModel({ name: "" }, { name: "AllPackagesDetails" });
  const Editor = staticModel({ data: { email: children.one(Email), phones: children.one(Phones), details: children.one(Details) },
    setup(self) {
      const form = createForm({ schema: () => ({ email: self.email.value!.field, phones: self.phones.value!.field, details: self.details.value!.field }) });
      const load = query({ handler: async (id: string) => ({ email: `${id}@example.com`, phones: [id], details: { name: id } }) });
      const page = route({ path: "/collections/:id" }), navigation = router({ routes: [page] });
      reaction({ on: page.opened, async run(payload) { await form.fill({ values: await load(payload.params!.id) }); } });
      return { form, page, navigation, connect(box: StorageBox) { return persist({ source: self.email.value!.value, key: "email", storage: box }); } };
    }, onCreate(self) { self.email.create({}); self.phones.create({}); self.details.create({}); },
  });
  const app = scope(), [a, b] = scoped(app, () => Editor.create([{}, {}]));
  const ef = fork(); associate({ virentia: app, effector: ef });
  const bridge = scoped(app, () => formToEffector(a.form)), box = memory(); a.connect(box);
  const reactHost = document.createElement("div"), vueHost = document.createElement("div"); document.body.append(reactHost, vueHost);
  const root = createRoot(reactHost);
  function ReactView() { const phones = useField(a.phones.value!.field), details = useField(a.details.value!.field); return createElement("p", null, `${JSON.stringify(phones.value)}|${JSON.stringify(details.value)}`); }
  const View = defineComponent({ setup() { const values = useUnit(b.form.values); return () => h("p", JSON.stringify(values.value)); } });
  const vue = createApp(defineComponent({ setup() { provideScope(app); return () => h(View); } }));
  try {
    await act(async () => root.render(createElement(ScopeProvider, { scope: app }, createElement(ReactView)))); vue.mount(vueHost);
    await a.navigation.setHistory(historyAdapter(createMemoryHistory())); await b.navigation.setHistory(historyAdapter(createMemoryHistory()));
    await act(async () => { await a.page.open({ params: { id: "react" } }); });
    await b.page.open({ params: { id: "vue" } }); await nextTick();
    await vi.waitFor(() => {
      expect(reactHost.textContent).toBe('["react"]|{"name":"react"}');
      expect(vueHost.textContent).toBe('{"email":"vue@example.com","phones":["vue"],"details":{"name":"vue"}}');
    });
    expect(box.get("email")).toBe("react@example.com");
    const change = scoped(app, () => bridge.fields.phones.first().change.target());
    await act(async () => { await allSettled(change, { scope: ef, params: "effector" }); });
    expect(reactHost.textContent).toBe('["effector"]|{"name":"react"}');
    expect(b.phones.value!.value.value).toEqual(["vue"]);
    expect(ef.getState(bridge.$values).phones).toEqual(["effector"]);
    await act(async () => { await a.phones.value!.field.remove(0); });
    expect(reactHost.textContent).toBe('[]|{"name":"react"}');
    expect(b.form.values.value.details).toEqual({ name: "vue" });
  } finally {
    await act(async () => root.unmount()); vue.unmount();
    await a.dispose(); await b.dispose(); reactHost.remove(); vueHost.remove();
  }
});

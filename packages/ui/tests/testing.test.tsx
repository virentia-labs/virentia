/** @jsxImportSource @virentia/ui */
import { effect, scope, scoped, store } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { collection } from "../../core/lib/models/collection";
import { expect, test } from "vitest";
import { action, component, computed, h, ref, render } from "../lib";

const shared = store(0);
const tick = effect(async () => {});
const Model = staticModel({ name: "ParallelCounter", data: { count: f.number(0) }, setup(self) {
  const input = ref<HTMLInputElement>();
  const increment = action(async () => { await tick(); self.count.value++; shared.value++; });
  return { input, increment, text: computed(() => String(self.count.value)), doubled: computed(() => self.count.value * 2) };
} });
const Counter = component({ model: Model, keep: true, view: (_props, self) =>
  <section><input ref={self.model.input} value={self.model.text} />
    <button onClick={self.model.increment}>{self.model.count}</button><output>{self.model.doubled}</output></section> });

for (const amount of [1, 3, 7, 11]) {
  test.concurrent("uses ordinary Vitest with its own scope (" + amount + ")", async () => {
    const appScope = scope();
    const page = document.implementation.createHTMLDocument("parallel test");
    const container = page.createElement("div");
    page.body.append(container);
    const counter = scoped(appScope, () => Counter.model.create({ id: "same" }));
    const unmount = render(() => <Counter model={counter} />, container, { scope: appScope });
    try {
      const button = container.querySelector("button");
      for (let index = 0; index < amount; index++) await counter.increment();
      expect(counter.doubled.value).toBe(amount * 2);
      expect(container.querySelector("button")).toBe(button);
      expect(button!.textContent).toBe(String(amount));
      expect(counter.input.value).toBe(container.querySelector("input"));
      expect(counter.input.value!.value).toBe(String(amount));
      expect(container.querySelector("output")!.textContent).toBe(String(amount * 2));
      expect(scoped(appScope, () => shared.value)).toBe(amount);
      expect(page).not.toBe(document);
    } finally {
      await unmount();
      await counter.dispose();
    }
  });
}

test("explicit model disposal does not touch the same ID in another scope", async () => {
  const scopeA = scope(), scopeB = scope();
  const first = scoped(scopeA, () => Counter.model.create({ id: "same" }));
  const second = scoped(scopeB, () => Counter.model.create({ id: "same" }));
  const firstContainer = document.createElement("div"), secondContainer = document.createElement("div");
  const firstUnmount = render(() => <Counter model={first} />, firstContainer, { scope: scopeA });
  const secondUnmount = render(() => <Counter model={second} />, secondContainer, { scope: scopeB });
  try {
    await first.dispose();
    expect(collection(Model, scopeA).ids).toEqual([]);
    expect(collection(Model, scopeB).ids).toEqual(["same"]);
    expect(secondContainer.querySelector("button")!.textContent).toBe("0");
  } finally {
    await firstUnmount(); await secondUnmount();
    await first.dispose(); await second.dispose();
  }
});

test("native render cleanup can be registered with a normal Vitest finally", async () => {
  const appScope = scope();
  const container = document.createElement("div");
  const counter = scoped(appScope, () => Counter.model.create({ id: "failed" }));
  const scenario = async () => {
    const unmount = render(() => <Counter model={counter} />, container, { scope: appScope });
    try { throw new Error("test failure"); }
    finally { await unmount(); await counter.dispose(); }
  };
  await expect(scenario()).rejects.toThrow("test failure");
  expect(collection(Model, appScope).ids).toEqual([]);
  expect(container.childNodes).toHaveLength(0);
});

test("independent roots may share a user-created scope without shared teardown", async () => {
  const appScope = scope();
  const first = document.createElement("div"), second = document.createElement("div");
  const firstUnmount = render(() => h("output", null, shared), first, { scope: appScope });
  const secondUnmount = render(() => h("output", null, shared), second, { scope: appScope });
  try {
    scoped(appScope, () => { shared.value = 1; });
    expect(first.textContent).toBe("1"); expect(second.textContent).toBe("1");
    await firstUnmount();
    scoped(appScope, () => { shared.value = 2; });
    expect(first.childNodes).toHaveLength(0);
    expect(second.textContent).toBe("2");
  } finally { await firstUnmount(); await secondUnmount(); }
});

// @vitest-environment happy-dom

import { allSettled, event, reaction, scope, scoped, store } from "@virentia/core";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick, ref, type Component } from "vue";
import { component, createModelCache, ScopeProvider, useProvidedScope, useUnit } from "../lib";
import type { ModelContext } from "../lib";

const wrappers: Array<{ unmount(): void }> = [];

afterEach(() => {
  while (wrappers.length) {
    wrappers.pop()?.unmount();
  }
});

describe("@virentia/vue", () => {
  it("reads stores and calls events in the provided scope", async () => {
    const appScope = scope();
    const otherScope = scope();
    const incremented = event<number>();
    const count = store(0);

    reaction({
      on: incremented,
      run(amount) {
        count.value += amount;
      },
    });

    const Counter = defineComponent({
      setup() {
        const value = useUnit(count);
        const increment = useUnit(incremented);

        return () => h("button", { onClick: () => increment(2) }, value.value);
      },
    });

    const wrapper = mountWithScope(appScope, Counter);

    expect(wrapper.text()).toBe("0");

    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toBe("2");

    await allSettled(incremented, { scope: otherScope, payload: 10 });
    await flushPromises();

    expect(wrapper.text()).toBe("2");
    scoped(otherScope, () => {
      expect(count.value).toBe(10);
    });
  });

  it("unwraps unit shapes with useUnit", async () => {
    const appScope = scope();
    const changed = event<string>();
    const name = store("Ada");
    const age = store(36);

    reaction({
      on: changed,
      run(value) {
        name.value = value;
      },
    });

    const Profile = defineComponent({
      setup() {
        const [currentName, currentAge] = useUnit([name, age] as const);
        const units = useUnit({ changed, name });

        return () =>
          h(
            "button",
            { onClick: () => units.changed("Grace") },
            `${currentName.value}:${units.name.value}:${currentAge.value}`,
          );
      },
    });

    const wrapper = mountWithScope(appScope, Profile);

    expect(wrapper.text()).toBe("Ada:Ada:36");

    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toBe("Grace:Grace:36");
  });

  it("throws when a scope is not provided", () => {
    const Reader = defineComponent({
      setup() {
        useProvidedScope();

        return () => null;
      },
    });

    expect(() => mount(Reader)).toThrow("[useProvidedScope] Scope is not provided");
  });

  it("creates component models, updates props, and emits lifecycle events", async () => {
    const appScope = scope();
    const lifecycle: string[] = [];

    function createCounterModel(context: ModelContext<{ step: number }>) {
      const clicked = event<void>();
      const count = store(0);

      reaction({
        on: clicked,
        run() {
          count.value += context.props.step;
        },
      });

      reaction({
        on: context.mounted,
        run() {
          lifecycle.push(`mounted:${context.mounts.value}`);
        },
      });

      reaction({
        on: context.unmounted,
        run() {
          lifecycle.push(`unmounted:${context.mounts.value}`);
        },
      });

      return { clicked, count };
    }

    const Counter = component({
      model: createCounterModel,
      view: counterView(),
    });

    const step = ref(2);
    const wrapper = mountHost(() =>
      h(ScopeProvider, { scope: appScope }, { default: () => h(Counter, { step: step.value }) }),
    );

    expect(lifecycle).toEqual(["mounted:1"]);

    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toBe("2");

    step.value = 3;
    await nextTick();
    await flushPromises();

    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toBe("5");

    wrapper.unmount();

    expect(lifecycle).toEqual(["mounted:1", "unmounted:0"]);
  });

  it("creates controlled component models outside Vue", async () => {
    const appScope = scope();
    const lifecycle: string[] = [];

    function createCounterModel(context: ModelContext<{ step: number }>) {
      const clicked = event<void>();
      const count = store(0);

      reaction({
        on: clicked,
        run() {
          count.value += context.props.step;
        },
      });

      reaction({
        on: context.mounted,
        run() {
          lifecycle.push(`mounted:${context.mounts.value}`);
        },
      });

      reaction({
        on: context.unmounted,
        run() {
          lifecycle.push(`unmounted:${context.mounts.value}`);
        },
      });

      return { clicked, count };
    }

    const Counter = component({
      model: createCounterModel,
      view: counterView(),
    });
    const model = scoped(appScope, () => Counter.create({ step: 2 }));
    const step = ref(2);
    const wrapper = mountHost(() => h(Counter, { step: step.value, model }));

    expect(lifecycle).toEqual(["mounted:1"]);

    await scoped(appScope, () => model.clicked());
    await flushPromises();
    expect(wrapper.text()).toBe("2");

    step.value = 5;
    await nextTick();
    await flushPromises();

    await scoped(appScope, () => model.clicked());
    await flushPromises();
    expect(wrapper.text()).toBe("7");

    wrapper.unmount();

    await scoped(appScope, () => model.clicked());

    scoped(appScope, () => {
      expect(model.count.value).toBe(12);
    });
    expect(lifecycle).toEqual(["mounted:1", "unmounted:0"]);

    model.dispose();
  });

  it("passes child component models through parent component models", async () => {
    const appScope = scope();

    function createCounterModel(context: ModelContext<{ step: number }>) {
      const clicked = event<void>();
      const count = store(0);

      reaction({
        on: clicked,
        run() {
          count.value += context.props.step;
        },
      });

      return { clicked, count };
    }

    const Counter = component({
      model: createCounterModel,
      view: counterView(),
    });
    const Parent = component({
      model() {
        const counter = Counter.create({ step: 1 });

        return { counter };
      },
      view: defineComponent({
        props: { model: { type: Object, required: true } },
        setup(props) {
          return () => h(Counter, { step: 2, model: props.model.counter });
        },
      }),
    });

    const wrapper = mountWithScope(appScope, Parent);

    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toBe("2");
  });

  it("keeps cached models alive across unmounts until the cache deletes them", async () => {
    const appScope = scope();
    let created = 0;

    function createCachedModel() {
      created += 1;
      const clicked = event<void>();
      const count = store(0);

      reaction({
        on: clicked,
        run() {
          count.value += 1;
        },
      });

      return { clicked, count };
    }

    const cache = createModelCache<string, { id: string }, ReturnType<typeof createCachedModel>>();
    const CachedCounter = component({
      cache,
      key: (props: { id: string }) => props.id,
      model: createCachedModel,
      view: counterView(),
    });

    const show = ref(true);
    const wrapper = mountHost(() =>
      h(
        ScopeProvider,
        { scope: appScope },
        { default: () => (show.value ? h(CachedCounter, { id: "chat:1" }) : null) },
      ),
    );

    await wrapper.get("button").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toBe("1");

    show.value = false;
    await nextTick();

    expect(cache.has("chat:1", appScope)).toBe(true);

    show.value = true;
    await nextTick();

    expect(wrapper.text()).toBe("1");
    expect(created).toBe(1);

    show.value = false;
    await nextTick();
    cache.delete("chat:1", appScope);
    show.value = true;
    await nextTick();

    expect(created).toBe(2);
    expect(wrapper.text()).toBe("0");
  });
});

function counterView(): Component {
  return defineComponent({
    props: { model: { type: Object, required: true } },
    setup(props) {
      return () => h("button", { onClick: () => props.model.clicked() }, props.model.count.value);
    },
  });
}

function mountWithScope(appScope: ReturnType<typeof scope>, inner: Component, props?: object) {
  return mountHost(() => h(ScopeProvider, { scope: appScope }, { default: () => h(inner, props) }));
}

function mountHost(render: () => unknown) {
  const Host = defineComponent({
    setup() {
      return () => render();
    },
  });
  const wrapper = mount(Host);

  wrappers.push(wrapper);

  return wrapper;
}

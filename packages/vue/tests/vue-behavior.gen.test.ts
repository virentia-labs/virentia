// @vitest-environment happy-dom

import {
  effect,
  event,
  reaction,
  reactive,
  scope,
  scoped,
  store,
  type EventCallable,
  type Store,
} from "@virentia/core";
import { getActiveScope, setActiveScope } from "@virentia/core/internal";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  defineComponent,
  effectScope,
  h,
  isRef,
  nextTick,
  ref,
  type Component,
  type Ref,
} from "vue";
import {
  component,
  createModelCache,
  provideScope,
  ScopeProvider,
  useModel,
  useProvidedScope,
  useUnit,
} from "../lib";
import type { ComponentModel, ModelContext, ReactiveModel, UnitRef, UnitShape } from "../lib";
import { useOptionalProvidedScope } from "../lib/scope";
import { getOrCreateCachedInstance } from "../lib/model-cache";
import {
  buildReactiveModel,
  createModelInstance,
  exposeModelInstance,
  readExposedModelInstance,
} from "../lib/use-model";
import { bindUnit } from "../lib/use-unit";
import { readStore, writeStore } from "../lib/utils";

const disposeSymbol =
  typeof Symbol.dispose === "symbol" ? Symbol.dispose : Symbol.for("Symbol.dispose");

const wrappers: Array<{ unmount(): void }> = [];

// Test isolation: mounting a Virentia component leaks the ambient scope (see the
// "suspected bug" test below), which would otherwise contaminate later tests
// that assert on the absence of an active scope. Reset it around every test.
beforeEach(() => {
  setActiveScope(null);
});

afterEach(() => {
  while (wrappers.length) {
    wrappers.pop()?.unmount();
  }
  setActiveScope(null);
});

// ---------------------------------------------------------------------------
// bindUnit / useUnit — store refs, cross-scope isolation, lifecycle
// ---------------------------------------------------------------------------

describe("bindUnit store refs", () => {
  it("seeds .value with a write applied just before binding (FR11)", () => {
    const appScope = scope();
    const count = store(0);

    scoped(appScope, () => {
      count.value = 42;
    });

    const ref0 = bindUnit(count, appScope) as Ref<number>;

    expect(ref0.value).toBe(42);
  });

  it("only updates for writes in the bound scope (FR9)", async () => {
    const scopeA = scope();
    const scopeB = scope();
    const count = store(0);

    const refA = bindUnit(count, scopeA) as Ref<number>;
    const refB = bindUnit(count, scopeB) as Ref<number>;

    scoped(scopeB, () => {
      count.value = 7;
    });
    await flushPromises();

    expect(refA.value).toBe(0);
    expect(refB.value).toBe(7);
  });

  it("two bindings of one store in the same scope both update (AI15)", async () => {
    const appScope = scope();
    const count = store(0);

    const first = bindUnit(count, appScope) as Ref<number>;
    const second = bindUnit(count, appScope) as Ref<number>;

    scoped(appScope, () => {
      count.value = 3;
    });
    await flushPromises();

    expect(first.value).toBe(3);
    expect(second.value).toBe(3);
  });

  it("works without a Vue effect scope and stays live (AI9)", () => {
    const appScope = scope();
    const count = store(1);

    // No effectScope on the stack -> getCurrentVueScope() is null -> no
    // onScopeDispose is registered, but the ref must still work and stay subscribed.
    const ref0 = bindUnit(count, appScope) as Ref<number>;

    expect(ref0.value).toBe(1);
    scoped(appScope, () => {
      count.value = 2;
    });
    expect(ref0.value).toBe(2);
  });

  it("unsubscribes on Vue effect-scope dispose and stops updating (FR10/AI9)", async () => {
    const appScope = scope();
    const count = store(0);
    const { unit: tracked, count: getActive } = trackSubscriptions(count);

    const es = effectScope();
    let bound!: Ref<number>;
    es.run(() => {
      bound = bindUnit(tracked, appScope) as Ref<number>;
    });

    expect(getActive()).toBe(1);

    scoped(appScope, () => {
      count.value = 5;
    });
    await flushPromises();
    expect(bound.value).toBe(5);

    es.stop();
    expect(getActive()).toBe(0);

    scoped(appScope, () => {
      count.value = 9;
    });
    await flushPromises();
    // Detached: no further updates.
    expect(bound.value).toBe(5);
  });

  it("leaks no subscribers across many mount/unmount cycles (FR10)", async () => {
    const appScope = scope();
    const count = store(0);
    const { unit: tracked, count: getActive } = trackSubscriptions(count);

    const Reader = defineComponent({
      setup() {
        const value = useUnit(tracked);
        return () => h("span", value.value);
      },
    });

    for (let i = 0; i < 5; i += 1) {
      const wrapper = mount(
        defineComponent({
          setup: () => () => h(ScopeProvider, { scope: appScope }, { default: () => h(Reader) }),
        }),
      );
      expect(getActive()).toBe(1);
      wrapper.unmount();
      expect(getActive()).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// readStore snapshots — primitive / array / object reactives (AI5/AI6/AI7/AI8)
// ---------------------------------------------------------------------------

describe("readStore snapshots", () => {
  it("returns the raw value for a primitive store (AI5)", () => {
    const appScope = scope();
    const s = store(5);

    expect(readStore(s, appScope)).toBe(5);
  });

  it("rebuilds an array reactive as a real Array (AI6)", () => {
    const appScope = scope();
    const arr = reactive([10, 20, 30]);

    const snapshot = readStore(arr, appScope) as number[];

    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot).toEqual([10, 20, 30]);
    expect(snapshot.length).toBe(3);
  });

  it("exposes an array reactive as an Array through useUnit binding (AI6)", () => {
    const appScope = scope();
    const arr = reactive([1, 2]);

    const bound = bindUnit(arr, appScope) as Ref<number[]>;

    expect(Array.isArray(bound.value)).toBe(true);
    expect(bound.value).toEqual([1, 2]);
  });

  it("snapshots an object reactive excluding native store keys (AI7)", () => {
    const appScope = scope();
    const user = reactive({ name: "Ada", age: 36 });

    const snapshot = readStore(user, appScope) as Record<string, unknown>;

    expect(snapshot).toEqual({ name: "Ada", age: 36 });
    for (const nativeKey of ["node", "subscribe", "writable", "map", "filter", "filterMap"]) {
      expect(nativeKey in snapshot).toBe(false);
    }
  });

  it("produces a fresh object reference on each update, latest-wins (AI8)", async () => {
    const appScope = scope();
    const user = reactive({ n: 1 });

    const bound = bindUnit(user, appScope) as Ref<{ n: number }>;
    const first = bound.value;
    expect(first).toEqual({ n: 1 });

    writeStore(user, { n: 2 }, appScope);
    writeStore(user, { n: 3 }, appScope);
    await flushPromises();

    expect(bound.value).toEqual({ n: 3 });
    // shallowRef with a fresh snapshot each read -> a new reference.
    expect(bound.value).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// bound callables — events and effects (FR5/FR6/AI13)
// ---------------------------------------------------------------------------

describe("bound event/effect callables", () => {
  it("dispatches an event inside the bound scope on every call (FR5/AI13)", async () => {
    const scopeA = scope();
    const scopeB = scope();
    const inc = event<void>();
    const count = store(0);

    reaction({
      on: inc,
      run() {
        count.value += 1;
      },
    });

    const boundToA = bindUnit(inc, scopeA) as () => Promise<void>;

    // Invoke while an unrelated scope is ambient on the stack.
    await scoped(scopeB, () => boundToA());
    await flushPromises();

    scoped(scopeA, () => expect(count.value).toBe(1));
    scoped(scopeB, () => expect(count.value).toBe(0));
  });

  it("resolves an effect to its Done value in the bound scope (FR6)", async () => {
    const appScope = scope();
    const loadFx = effect(async (id: number) => `#${id}`);

    const call = bindUnit(loadFx, appScope) as (id: number) => Promise<string>;

    await expect(call(7)).resolves.toBe("#7");
  });

  it("propagates an effect rejection through the bound callable (FR6 edge)", async () => {
    const appScope = scope();
    const boomFx = effect(async () => {
      throw new Error("nope");
    });

    const call = bindUnit(boomFx, appScope) as () => Promise<void>;

    await expect(call()).rejects.toThrow("nope");
  });
});

// ---------------------------------------------------------------------------
// buildReactiveModel — skip rules, depth unwrap, ComponentModel pass-through
// ---------------------------------------------------------------------------

describe("buildReactiveModel", () => {
  it("omits dispose and non-enumerable keys, binds enumerable stores (AI1)", () => {
    const appScope = scope();
    const model: Record<PropertyKey, unknown> = { value: store(7) };
    Object.defineProperty(model, "dispose", {
      value: () => {},
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(model, "hidden", {
      value: store(1),
      enumerable: false,
      configurable: true,
    });

    const reactiveModel = buildReactiveModel(model, appScope) as Record<PropertyKey, unknown>;

    expect("dispose" in reactiveModel).toBe(false);
    expect("hidden" in reactiveModel).toBe(false);
    expect(isRef(reactiveModel.value)).toBe(true);
    expect((reactiveModel.value as Ref<number>).value).toBe(7);
  });

  it("skips a Symbol.dispose key (AI1)", () => {
    const appScope = scope();
    const model: Record<PropertyKey, unknown> = { count: store(0) };
    Object.defineProperty(model, disposeSymbol, {
      value: () => {},
      enumerable: true,
      configurable: true,
    });

    const reactiveModel = buildReactiveModel(model, appScope) as Record<PropertyKey, unknown>;

    expect(disposeSymbol in reactiveModel).toBe(false);
    expect(isRef(reactiveModel.count)).toBe(true);
  });

  it("unwraps units nested two levels deep and keeps them reactive (AI2)", async () => {
    const appScope = scope();
    const flag = store(false);
    const model = { group: { inner: { flag } } };

    const reactiveModel = buildReactiveModel(model, appScope) as {
      group: { inner: { flag: Ref<boolean> } };
    };

    expect(isRef(reactiveModel.group.inner.flag)).toBe(true);
    expect(reactiveModel.group.inner.flag.value).toBe(false);

    scoped(appScope, () => {
      flag.value = true;
    });
    await flushPromises();
    expect(reactiveModel.group.inner.flag.value).toBe(true);
  });

  it("carries an enumerable symbol-keyed store field into the model (AI4)", () => {
    const appScope = scope();
    const sym = Symbol("field");
    const s = store(5);
    const model = { [sym]: s };

    const reactiveModel = buildReactiveModel(model, appScope) as Record<symbol, Ref<number>>;

    expect(isRef(reactiveModel[sym])).toBe(true);
    expect(reactiveModel[sym].value).toBe(5);
  });

  it("recurses a plain object but passes a ComponentModel sibling through (FR25/AI3)", () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });
    const child = scoped(appScope, () => Counter.create({ step: 1 }));

    const parent = { plain: { s: store(1) }, child };
    const reactiveModel = buildReactiveModel(parent, appScope) as {
      plain: { s: Ref<number> };
      child: typeof child;
    };

    // Plain object recursed -> store becomes a ref.
    expect(isRef(reactiveModel.plain.s)).toBe(true);
    expect(reactiveModel.plain.s.value).toBe(1);

    // ComponentModel passed through unchanged (same reference, raw units).
    expect(reactiveModel.child).toBe(child);
    // The child's units stay raw: `.count` is still the store (has `.subscribe`),
    // not rebound to a Vue ref. Reading `.subscribe` does not read store state.
    expect(typeof (reactiveModel.child as { count: { subscribe?: unknown } }).count.subscribe).toBe(
      "function",
    );

    child.dispose();
  });
});

// ---------------------------------------------------------------------------
// exposeModelInstance / readExposedModelInstance (FR23/AI12)
// ---------------------------------------------------------------------------

describe("exposeModelInstance", () => {
  it("does not overwrite a pre-existing dispose but still installs the instance symbol (AI12)", () => {
    const appScope = scope();
    const instance = scoped(appScope, () =>
      createModelInstance(createCounterModel, { step: 1 }, appScope, undefined),
    );
    const model = instance.model as Record<PropertyKey, unknown>;
    const originalDispose = () => {};
    Object.defineProperty(model, "dispose", {
      value: originalDispose,
      configurable: true,
      enumerable: true,
    });

    exposeModelInstance(instance);

    expect(model.dispose).toBe(originalDispose);
    expect(readExposedModelInstance(instance.model as ComponentModel<typeof instance.model>)).toBe(
      instance,
    );

    instance.dispose();
  });

  it("exposes instance, dispose, and Symbol.dispose that tear down the model (FR23)", async () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });
    const model = scoped(appScope, () => Counter.create({ step: 2 }));

    expect(readExposedModelInstance(model)).toBeTruthy();
    expect(typeof model.dispose).toBe("function");
    expect(typeof (model as unknown as Record<PropertyKey, unknown>)[disposeSymbol]).toBe(
      "function",
    );

    await scoped(appScope, () => (model as { clicked: () => Promise<void> }).clicked());
    await flushPromises();
    scoped(appScope, () => expect((model as { count: Store<number> }).count.value).toBe(2));

    model.dispose();

    // Reactions were torn down: dispatching no longer mutates the store.
    await scoped(appScope, () => (model as { clicked: () => Promise<void> }).clicked());
    await flushPromises();
    scoped(appScope, () => expect((model as { count: Store<number> }).count.value).toBe(2));
  });

  it("Symbol.dispose tears down the model too (FR23)", async () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });
    const model = scoped(appScope, () => Counter.create({ step: 3 })) as unknown as Record<
      PropertyKey,
      unknown
    > & {
      clicked: () => Promise<void>;
      count: Store<number>;
    };

    await scoped(appScope, () => model.clicked());
    await flushPromises();
    scoped(appScope, () => expect(model.count.value).toBe(3));

    (model[disposeSymbol] as () => void)();

    await scoped(appScope, () => model.clicked());
    await flushPromises();
    scoped(appScope, () => expect(model.count.value).toBe(3));
  });
});

// ---------------------------------------------------------------------------
// useModel — plain object, factory, cache overloads (FR1/FR2/FR3)
// ---------------------------------------------------------------------------

describe("useModel", () => {
  it("binds a plain object's stores to refs and events to callables (FR1)", async () => {
    const appScope = scope();
    const inc = event<void>();
    const count = store(0);
    reaction({
      on: inc,
      run() {
        count.value += 1;
      },
    });
    const plain = { inc, count };

    const Comp = defineComponent({
      setup() {
        const model = useModel(plain);
        expect(isRef(model.count)).toBe(true);
        return () =>
          h("button", { onClick: () => (model.inc as () => void)() }, model.count.value);
      },
    });

    const wrapper = mountWithScope(appScope, Comp);
    expect(wrapper.text()).toBe("0");

    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toBe("1");
  });

  it("factory model reflects props and reacts to prop-ref changes (FR2)", async () => {
    const appScope = scope();
    const stepRef = ref(2);

    function factory(context: ModelContext<{ step: number }>) {
      const view = store(context.props.step);
      reaction({
        on: context.props,
        run(next) {
          view.value = next.step;
        },
      });
      return { view };
    }

    const Comp = defineComponent({
      setup() {
        const model = useModel(factory, () => ({ step: stepRef.value }));
        return () => h("span", model.view.value);
      },
    });

    const wrapper = mountWithScope(appScope, Comp);
    expect(wrapper.text()).toBe("2");

    stepRef.value = 5;
    await nextTick();
    await flushPromises();
    expect(wrapper.text()).toBe("5");
  });

  it("keeps a cached model alive across unmount/remount (FR3)", async () => {
    const appScope = scope();
    let created = 0;

    function factory() {
      created += 1;
      const inc = event<void>();
      const count = store(0);
      reaction({
        on: inc,
        run() {
          count.value += 1;
        },
      });
      return { inc, count };
    }

    const cache = createModelCache<string, object, ReturnType<typeof factory>>();

    const Comp = defineComponent({
      setup() {
        const model = useModel(factory, () => ({}), { cache, key: "k" });
        return () =>
          h("button", { onClick: () => (model.inc as () => void)() }, model.count.value);
      },
    });

    const show = ref(true);
    const wrapper = mountHost(() =>
      h(
        ScopeProvider,
        { scope: appScope },
        { default: () => (show.value ? h(Comp) : null) },
      ),
    );

    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toBe("1");
    expect(created).toBe(1);

    show.value = false;
    await nextTick();
    expect(cache.has("k", appScope)).toBe(true);

    show.value = true;
    await nextTick();
    expect(wrapper.text()).toBe("1");
    expect(created).toBe(1);

    cache.delete("k", appScope);
  });
});

// ---------------------------------------------------------------------------
// scope providers (FR12/FR13/FR14/FR15)
// ---------------------------------------------------------------------------

describe("scope providers", () => {
  it("provideScope called directly satisfies useProvidedScope (FR13)", () => {
    const appScope = scope();
    let received: unknown;

    const Child = defineComponent({
      setup() {
        received = useProvidedScope();
        return () => null;
      },
    });
    const Parent = defineComponent({
      setup() {
        provideScope(appScope);
        return () => h(Child);
      },
    });

    mountHost(() => h(Parent));
    expect(received).toBe(appScope);
  });

  it("useOptionalProvidedScope returns null or the provided scope (FR14)", () => {
    const appScope = scope();
    let withoutProvider: unknown = "sentinel";
    let withProvider: unknown = "sentinel";

    const A = defineComponent({
      setup() {
        withoutProvider = useOptionalProvidedScope();
        return () => null;
      },
    });
    const B = defineComponent({
      setup() {
        withProvider = useOptionalProvidedScope();
        return () => null;
      },
    });

    mountHost(() => h(A));
    expect(withoutProvider).toBe(null);

    mountHost(() => h(ScopeProvider, { scope: appScope }, { default: () => h(B) }));
    expect(withProvider).toBe(appScope);
  });

  it("useProvidedScope throws when no scope is provided (FR12)", () => {
    const Reader = defineComponent({
      setup() {
        useProvidedScope();
        return () => null;
      },
    });

    expect(() => mount(Reader)).toThrow("[useProvidedScope] Scope is not provided");
  });

  it("ScopeProvider renders its default slot (FR15)", () => {
    const appScope = scope();
    const wrapper = mountHost(() =>
      h(ScopeProvider, { scope: appScope }, { default: () => h("div", "hi") }),
    );
    expect(wrapper.text()).toBe("hi");
  });
});

// ---------------------------------------------------------------------------
// component() — forwarding, error paths, lifecycle, controlled models
// ---------------------------------------------------------------------------

describe("component()", () => {
  it("forwards non-model attrs and injects the reactive model (FR16)", async () => {
    const appScope = scope();
    let seen: Record<string, unknown> | undefined;

    const view: Component = defineComponent({
      props: { model: { type: Object, required: true } },
      inheritAttrs: false,
      setup(props, { attrs }) {
        seen = { ...attrs, model: props.model };
        return () => h("div", `${(attrs as { step: number }).step}:${(attrs as { extra: string }).extra}`);
      },
    });
    const Widget = component({ model: createCounterModel, view });

    const wrapper = mountHost(() =>
      h(ScopeProvider, { scope: appScope }, { default: () => h(Widget, { step: 2, extra: "x" }) }),
    );
    await flushPromises();

    expect(seen).toBeTruthy();
    expect(seen!.step).toBe(2);
    expect(seen!.extra).toBe("x");
    expect(seen!.model).toBeTruthy();
    expect(isRef((seen!.model as { count: unknown }).count)).toBe(true);
    expect(wrapper.text()).toBe("2:x");
  });

  it("throws when a bare object is passed as the model prop (FR20)", () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });

    expect(() =>
      mount(
        defineComponent({
          setup: () => () =>
            h(
              ScopeProvider,
              { scope: appScope },
              {
                default: () =>
                  h(Counter, {
                    step: 1,
                    model: { not: "real" } as unknown as ComponentModel<
                      ReturnType<typeof createCounterModel>
                    >,
                  }),
              },
            ),
        }),
      ),
    ).toThrow("[component] The model prop must be created with component.create().");
  });

  it("throws when uncontrolled and no scope is provided (FR21)", () => {
    const Counter = component({ model: createCounterModel, view: counterView() });

    expect(() =>
      mount(
        defineComponent({
          setup: () => () => h(Counter, { step: 1 }),
        }),
      ),
    ).toThrow("[useProvidedScope] Scope is not provided");
  });

  // SUSPECTED BUG: onMounted/onUnmounted fire lifecycle events fire-and-forget
  // (`void instance.mounted()`) inside `scoped(scope, () => …)`. Because that
  // callback is non-thenable, `scoped` restores the ambient synchronously, but
  // the event's async reaction drain re-installs `scope` as the global ambient
  // and never restores it. After any Virentia component mounts, getActiveScope()
  // stays non-null, silently breaking scope isolation (and component.create()'s
  // "no surrounding scope" guard). Correct behavior: no ambient scope should
  // survive a mount. Marked `.fails` because the code currently leaks.
  it.fails("does not leak the ambient scope after a component mounts (suspected bug)", async () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });

    const wrapper = mountHost(() =>
      h(ScopeProvider, { scope: appScope }, { default: () => h(Counter, { step: 1 }) }),
    );
    await flushPromises();

    expect(getActiveScope()).toBe(null);
    wrapper.unmount();
  });

  it("throws from create() when there is no surrounding virentia scope (FR22)", () => {
    const Counter = component({ model: createCounterModel, view: counterView() });

    expect(() => Counter.create({ step: 1 })).toThrow(
      "[component.create] Parent component context is required.",
    );
  });

  it("clamps mounts at zero on unmount (FR17/AI11)", async () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });
    const model = scoped(appScope, () => Counter.create({ step: 1 }));
    const instance = readExposedModelInstance(model)!;

    const wrapper = mountHost(() => h(Counter, { step: 1, model }));
    await flushPromises();
    scoped(appScope, () => expect(instance.mounts.value).toBe(1));

    // Force the counter to 0 so unmount's Math.max clamp is exercised.
    scoped(appScope, () => {
      instance.mounts.value = 0;
    });

    wrapper.unmount();
    scoped(appScope, () => expect(instance.mounts.value).toBe(0));

    model.dispose();
  });

  it("emits ordered lifecycle events with a live mounts counter (FR17)", async () => {
    const appScope = scope();
    const lifecycle: string[] = [];

    function model(context: ModelContext<{ step: number }>) {
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
      return { count: store(0), clicked: event<void>() };
    }

    const Counter = component({ model, view: counterView() });
    const wrapper = mountWithScope(appScope, Counter, { step: 1 });
    await flushPromises();
    expect(lifecycle).toEqual(["mounted:1"]);

    wrapper.unmount();
    expect(lifecycle).toEqual(["mounted:1", "unmounted:0"]);
  });

  it("rewrites the whole props object when a nested prop changes (FR18)", async () => {
    const appScope = scope();
    const filterRef = ref<{ q: string }>({ q: "a" });

    function model(context: ModelContext<{ filter: { q: string } }>) {
      const q = store(context.props.filter.q);
      reaction({
        on: context.props,
        run(next) {
          q.value = next.filter.q;
        },
      });
      return { q, clicked: event<void>(), count: store(0) };
    }

    const view: Component = defineComponent({
      props: { model: { type: Object, required: true } },
      setup(props) {
        return () => h("span", (props.model as { q: { value: string } }).q.value);
      },
    });
    const Widget = component({ model, view });

    const wrapper = mountHost(() =>
      h(
        ScopeProvider,
        { scope: appScope },
        { default: () => h(Widget, { filter: filterRef.value }) },
      ),
    );
    await flushPromises();
    expect(wrapper.text()).toBe("a");

    filterRef.value = { q: "b" };
    await nextTick();
    await flushPromises();
    expect(wrapper.text()).toBe("b");
  });

  it("keeps a controlled model usable and undisposed after host unmount (FR19)", async () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });
    const model = scoped(appScope, () => Counter.create({ step: 2 })) as unknown as Record<
      PropertyKey,
      unknown
    > & {
      clicked: () => Promise<void>;
      count: Store<number>;
    };

    const wrapper = mountHost(() =>
      h(Counter, {
        step: 2,
        model: model as unknown as ComponentModel<ReturnType<typeof createCounterModel>>,
      }),
    );
    await flushPromises();

    await scoped(appScope, () => model.clicked());
    await flushPromises();
    scoped(appScope, () => expect(model.count.value).toBe(2));

    wrapper.unmount();

    // NOT disposed on unmount: the external model still processes events.
    await scoped(appScope, () => model.clicked());
    await flushPromises();
    scoped(appScope, () => expect(model.count.value).toBe(4));

    (model.dispose as () => void)();
  });

  it("passes a child ComponentModel through a parent model unchanged (FR25)", async () => {
    const appScope = scope();
    const Counter = component({ model: createCounterModel, view: counterView() });
    const Parent = component({
      model() {
        const counter = Counter.create({ step: 2 });
        return { counter };
      },
      view: defineComponent({
        props: { model: { type: Object, required: true } },
        setup(props) {
          return () =>
            h(Counter, {
              step: 2,
              model: (props.model as { counter: unknown }).counter as ComponentModel<
                ReturnType<typeof createCounterModel>
              >,
            });
        },
      }),
    });

    const wrapper = mountWithScope(appScope, Parent);
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// createModelCache — scoped/cross-scope lookup, delete, clear, guards
// ---------------------------------------------------------------------------

describe("createModelCache", () => {
  function makeInstance(cacheScope: ReturnType<typeof scope>, key: string, onDispose?: () => void) {
    const instance = scoped(cacheScope, () =>
      createModelInstance(() => ({ count: store(0) }), {}, cacheScope, key),
    );
    if (onDispose) {
      const original = instance.dispose.bind(instance);
      instance.dispose = () => {
        onDispose();
        original();
      };
    }
    return instance;
  }

  it("resolves has/get/getInstance scoped and cross-scope (FR26/FR30)", () => {
    const cache = createModelCache<string, object, { count: Store<number> }>();
    const scopeA = scope();
    const scopeB = scope();

    const instA = getOrCreateCachedInstance(cache, scopeA, "k", () => makeInstance(scopeA, "k"));

    expect(cache.has("k", scopeA)).toBe(true);
    expect(cache.get("k", scopeA)).toBe(instA.model);
    expect(cache.getInstance("k", scopeA)).toBe(instA);

    // Cross-scope find (no scope) locates it via the Set-tracked maps.
    expect(cache.has("k")).toBe(true);
    expect(cache.getInstance("k")).toBe(instA);

    // Wrong scope / missing key.
    expect(cache.has("k", scopeB)).toBe(false);
    expect(cache.getInstance("missing", scopeA)).toBeUndefined();

    cache.clear();
  });

  it("delete returns false for a missing key and disposes on a hit (FR27)", () => {
    const cache = createModelCache<string, object, { count: Store<number> }>();
    const scopeA = scope();

    expect(cache.delete("missing", scopeA)).toBe(false);

    let disposed = false;
    getOrCreateCachedInstance(cache, scopeA, "k", () => makeInstance(scopeA, "k", () => (disposed = true)));

    expect(cache.delete("k", scopeA)).toBe(true);
    expect(disposed).toBe(true);
    expect(cache.has("k", scopeA)).toBe(false);
  });

  it("scope-less delete removes a matching key across all scopes (FR27/AI14)", () => {
    const cache = createModelCache<string, object, { count: Store<number> }>();
    const scopeA = scope();
    const scopeB = scope();
    let disposedA = false;
    let disposedB = false;

    getOrCreateCachedInstance(cache, scopeA, "shared", () =>
      makeInstance(scopeA, "shared", () => (disposedA = true)),
    );
    getOrCreateCachedInstance(cache, scopeB, "shared", () =>
      makeInstance(scopeB, "shared", () => (disposedB = true)),
    );

    expect(cache.delete("shared")).toBe(true);
    expect(disposedA).toBe(true);
    expect(disposedB).toBe(true);
    expect(cache.has("shared")).toBe(false);
  });

  it("clear disposes a single scope, then everything (FR28)", () => {
    const cache = createModelCache<string, object, { count: Store<number> }>();
    const scopeA = scope();
    const scopeB = scope();
    let disposedA = false;
    let disposedB = false;

    getOrCreateCachedInstance(cache, scopeA, "a", () =>
      makeInstance(scopeA, "a", () => (disposedA = true)),
    );
    getOrCreateCachedInstance(cache, scopeB, "b", () =>
      makeInstance(scopeB, "b", () => (disposedB = true)),
    );

    cache.clear(scopeA);
    expect(disposedA).toBe(true);
    expect(disposedB).toBe(false);
    expect(cache.has("a", scopeA)).toBe(false);
    expect(cache.has("b", scopeB)).toBe(true);

    cache.clear();
    expect(disposedB).toBe(true);
    expect(cache.has("b", scopeB)).toBe(false);
  });

  it("rejects a foreign cache object lacking the internal symbol (FR29)", () => {
    const scopeA = scope();
    const foreign = {
      has: () => false,
      get: () => undefined,
      getInstance: () => undefined,
      delete: () => false,
      clear: () => {},
    } as unknown as ReturnType<typeof createModelCache<string, object, { count: Store<number> }>>;

    expect(() =>
      getOrCreateCachedInstance(foreign, scopeA, "k", () => makeInstance(scopeA, "k")),
    ).toThrow("[useModel] Unsupported model cache. Use createModelCache().");
  });

  it("returns the same cached instance on repeated get-or-create (AI14)", () => {
    const cache = createModelCache<string, object, { count: Store<number> }>();
    const scopeA = scope();

    const first = getOrCreateCachedInstance(cache, scopeA, "k", () => makeInstance(scopeA, "k"));
    let secondFactoryRan = false;
    const second = getOrCreateCachedInstance(cache, scopeA, "k", () => {
      secondFactoryRan = true;
      return makeInstance(scopeA, "k");
    });

    expect(second).toBe(first);
    expect(secondFactoryRan).toBe(false);

    cache.clear();
  });
});

// ---------------------------------------------------------------------------
// adversarial extras — ordering, positional shape, component-level isolation
// ---------------------------------------------------------------------------

describe("adversarial extras", () => {
  it("primitive store ref lands on the last of many synchronous scoped writes (ordering)", async () => {
    const appScope = scope();
    const count = store(0);

    const bound = bindUnit(count, appScope) as Ref<number>;

    scoped(appScope, () => {
      count.value = 1;
      count.value = 2;
      count.value = 3;
    });
    await flushPromises();

    expect(bound.value).toBe(3);
  });

  it("useUnit(tuple) preserves positional order for mixed store/event units (FR7)", async () => {
    const appScope = scope();
    const first = store("a");
    const go = event<string>();
    const third = store(1);
    reaction({
      on: go,
      run(v) {
        first.value = v;
      },
    });

    let bound!: readonly unknown[];
    const Comp = defineComponent({
      setup() {
        bound = useUnit([first, go, third] as const);
        return () => null;
      },
    });
    mountWithScope(appScope, Comp);

    // Positions: [0] store ref, [1] event callable, [2] store ref.
    expect(isRef(bound[0])).toBe(true);
    expect(typeof bound[1]).toBe("function");
    expect(isRef(bound[2])).toBe(true);
    expect((bound[0] as Ref<string>).value).toBe("a");
    expect((bound[2] as Ref<number>).value).toBe(1);

    await (bound[1] as (v: string) => Promise<void>)("z");
    await flushPromises();
    expect((bound[0] as Ref<string>).value).toBe("z");
  });

  it("isolates two mounted components bound to one store in different scopes (FR9 wild)", async () => {
    const scopeA = scope();
    const scopeB = scope();
    const count = store(0);

    const Reader = defineComponent({
      setup() {
        const value = useUnit(count);
        return () => h("span", value.value);
      },
    });

    const a = mountWithScope(scopeA, Reader);
    const b = mountWithScope(scopeB, Reader);

    expect(a.text()).toBe("0");
    expect(b.text()).toBe("0");

    scoped(scopeB, () => {
      count.value = 9;
    });
    await flushPromises();
    await nextTick();

    expect(a.text()).toBe("0");
    expect(b.text()).toBe("9");
  });

  it("scoped delete removes only that scope while cross-scope find still resolves the sibling (FR27/FR30)", () => {
    const cache = createModelCache<string, object, { count: Store<number> }>();
    const scopeA = scope();
    const scopeB = scope();

    const instA = getOrCreateCachedInstance(cache, scopeA, "k", () =>
      scoped(scopeA, () => createModelInstance(() => ({ count: store(0) }), {}, scopeA, "k")),
    );
    const instB = getOrCreateCachedInstance(cache, scopeB, "k", () =>
      scoped(scopeB, () => createModelInstance(() => ({ count: store(0) }), {}, scopeB, "k")),
    );

    expect(cache.delete("k", scopeA)).toBe(true);
    expect(cache.has("k", scopeA)).toBe(false);
    // scopeB survives; scope-less find now resolves the remaining sibling.
    expect(cache.getInstance("k", scopeB)).toBe(instB);
    expect(cache.getInstance("k")).toBe(instB);
    expect(instA).not.toBe(instB);

    cache.clear();
    expect(cache.has("k")).toBe(false);
  });

  it("bound event callable returns a thenable Promise<void> (FR5)", async () => {
    const appScope = scope();
    const ping = event<void>();

    const call = bindUnit(ping, appScope) as () => Promise<void>;
    const result = call();

    expect(typeof result.then).toBe("function");
    await expect(result).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// type smoke checks (behavioral suite; the dedicated type wave is exhaustive)
// ---------------------------------------------------------------------------

describe("type smoke", () => {
  it("ReactiveModel drops the dispose key", () => {
    type View = ReactiveModel<{ count: Store<number>; dispose(): void }>;
    expectTypeOf<"dispose" extends keyof View ? true : false>().toEqualTypeOf<false>();
  });

  it("UnitRef maps an event to a payload callable", () => {
    expectTypeOf<UnitRef<EventCallable<string>>>().toEqualTypeOf<
      (payload: string) => Promise<void>
    >();
  });

  it("UnitShape over a record yields refs and callables per key", () => {
    type Shape = UnitShape<{ a: Store<number>; go: EventCallable<void> }>;
    expectTypeOf<Shape["a"]>().toEqualTypeOf<Readonly<Ref<number>>>();
    expectTypeOf<Shape["go"]>().toEqualTypeOf<(payload?: void) => Promise<void>>();
  });
});

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

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

function counterView(): Component {
  return defineComponent({
    props: { model: { type: Object, required: true } },
    setup(props) {
      return () =>
        h(
          "button",
          { onClick: () => (props.model as { clicked: () => void }).clicked() },
          (props.model as { count: { value: number } }).count.value,
        );
    },
  });
}

// A store is a Proxy whose `set` trap rejects writes to `subscribe`, so we can't
// monkeypatch it in place. Instead wrap it in an outer Proxy that intercepts the
// `subscribe` getter to count live subscriptions.
function trackSubscriptions<T extends object>(unit: T): { unit: T; count: () => number } {
  let active = 0;
  const proxied = new Proxy(unit, {
    get(target, prop, receiver) {
      if (prop === "subscribe") {
        return (fn: any) => {
          active += 1;
          const unsubscribe = (target as { subscribe: (fn: any) => () => void }).subscribe(fn);
          let released = false;
          return () => {
            if (!released) {
              released = true;
              active -= 1;
            }
            return unsubscribe();
          };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { unit: proxied, count: () => active };
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

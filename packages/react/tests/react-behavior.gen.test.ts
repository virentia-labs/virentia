// @vitest-environment happy-dom

import {
  effect,
  event,
  reaction,
  reactive,
  scope,
  scoped,
  store,
  type EffectCallOptions,
  type EventCallable,
  type Scope,
  type Store,
} from "@virentia/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  act,
  Component,
  createElement,
  StrictMode,
  useState,
  type ReactNode,
} from "react";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  component,
  createModelCache,
  ScopeProvider,
  useModel,
  useUnit,
  type ComponentModel,
  type ModelContext,
  type ReactiveModel,
  type UnitValue,
} from "../lib";
import {
  createModelInstance,
  readExposedModelInstance,
} from "../lib/use-model";
import { getOrCreateCachedInstance } from "../lib/model-cache";
import { useOptionalProvidedScope } from "../lib/scope";
import { isPlainObject, isStoreUnit, isUnitLike, readStore } from "../lib/utils";
import type { UnitShape } from "../lib/types";
// Test-only: reset core's module-global ambient scope between tests (see afterEach).
import { setActiveScope } from "../../core/lib/scope/internal";

afterEach(async () => {
  cleanup();
  // Flush a macrotask so any fire-and-forget `scoped(...)` promise chain from a
  // click settles and restores the ambient scope before the next test runs.
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Test hygiene: a render that crashes mid-flight (the Rules-of-Hooks probes)
  // or overlapping async `scoped(...)` calls can leave core's module-global
  // active scope set. Force it back to null so per-test isolation holds
  // (notably CO8, which asserts there is NO active scope). See suspected core
  // bug in the report.
  setActiveScope(null);
});

// Runs `render` and drives an interaction that is expected to violate the
// Rules-of-Hooks. React reports the error to the nearest error boundary (so
// `act` may not rethrow); we surface whichever error was produced.
async function captureHookError(
  click: () => void,
  errors: Error[],
): Promise<Error[]> {
  const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
  let thrown: Error | null = null;
  try {
    await act(async () => {
      click();
    });
  } catch (error) {
    thrown = error as Error;
  }
  consoleErr.mockRestore();
  return thrown ? [...errors, thrown] : errors;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function renderWithScope(appScope: Scope, element: ReactNode) {
  return render(createElement(ScopeProvider, { scope: appScope }, element));
}

function withScope(appScope: Scope, element: ReactNode): ReactNode {
  return createElement(ScopeProvider, { scope: appScope }, element);
}

function button() {
  return screen.getByRole("button");
}

function readIn<T>(sc: Scope, fn: () => T): T {
  return scoped(sc, fn);
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class ErrorBoundary extends Component<
  { onError: (error: Error) => void; children?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// ===========================================================================
// useUnit — single store
// ===========================================================================

describe("useUnit / store binding", () => {
  it("UU1/UU7: reads the store value in the provided scope and re-renders once per scoped write", async () => {
    const appScope = scope();
    const bump = event<void>();
    const count = store(0);
    reaction({ on: bump, run: () => (count.value += 1) });

    let renders = 0;
    function Counter() {
      renders += 1;
      const value = useUnit(count);
      return createElement("span", null, String(value));
    }

    renderWithScope(appScope, createElement(Counter));
    expect(screen.getByText("0")).toBeTruthy();
    const base = renders;

    await act(async () => {
      await scoped(appScope, () => bump());
    });

    expect(screen.getByText("1")).toBeTruthy();
    // Exactly one additional render for one committed write.
    expect(renders - base).toBe(1);
  });

  it("UU6: a write in a foreign scope never re-renders the bound component", async () => {
    const scopeA = scope();
    const scopeB = scope();
    const bump = event<void>();
    const count = store(0);
    reaction({ on: bump, run: () => (count.value += 1) });

    let renders = 0;
    function Counter() {
      renders += 1;
      return createElement("span", null, String(useUnit(count)));
    }

    renderWithScope(scopeA, createElement(Counter));
    const base = renders;
    expect(screen.getByText("0")).toBeTruthy();

    await act(async () => {
      await scoped(scopeB, () => bump());
    });

    // Bound component unchanged; no extra render.
    expect(screen.getByText("0")).toBeTruthy();
    expect(renders).toBe(base);
    readIn(scopeB, () => expect(count.value).toBe(1));
    readIn(scopeA, () => expect(count.value).toBe(0));
  });

  it("UU13: multiple synchronous writes in one dispatch coalesce to a single render with the latest value", async () => {
    const appScope = scope();
    const bump = event<void>();
    const count = store(0);
    reaction({
      on: bump,
      run() {
        count.value += 1;
        count.value += 1;
        count.value += 1;
      },
    });

    let renders = 0;
    function Counter() {
      renders += 1;
      return createElement("span", null, String(useUnit(count)));
    }

    renderWithScope(appScope, createElement(Counter));
    const base = renders;

    await act(async () => {
      await scoped(appScope, () => bump());
    });

    expect(screen.getByText("3")).toBeTruthy();
    expect(renders - base).toBe(1);
  });

  it("SC5/UU6: sibling ScopeProviders isolate reads and writes", async () => {
    const scopeA = scope();
    const scopeB = scope();
    const bump = event<void>();
    const count = store(0);
    reaction({ on: bump, run: () => (count.value += 1) });

    let rendersB = 0;
    function Counter({ tid }: { tid: string }) {
      if (tid === "b") rendersB += 1;
      return createElement("span", { "data-testid": tid }, String(useUnit(count)));
    }

    render(
      createElement(
        "div",
        null,
        withScope(scopeA, createElement(Counter, { tid: "a" })),
        withScope(scopeB, createElement(Counter, { tid: "b" })),
      ),
    );

    expect(screen.getByTestId("a").textContent).toBe("0");
    expect(screen.getByTestId("b").textContent).toBe("0");
    const baseB = rendersB;

    await act(async () => {
      await scoped(scopeA, () => bump());
    });

    expect(screen.getByTestId("a").textContent).toBe("1");
    expect(screen.getByTestId("b").textContent).toBe("0");
    expect(rendersB).toBe(baseB);
  });
});

// ===========================================================================
// useUnit — object / array reactive stores
// ===========================================================================

describe("useUnit / reactive snapshots", () => {
  it("UU10: unwraps an object reactive to a plain snapshot and stays reactive", async () => {
    const appScope = scope();
    const user = reactive({ name: "Ada", age: 36 });

    function Profile() {
      const value = useUnit(user);
      return createElement("span", null, `${value.name}:${value.age}`);
    }

    renderWithScope(appScope, createElement(Profile));
    expect(screen.getByText("Ada:36")).toBeTruthy();

    await act(async () => {
      scoped(appScope, () => {
        user.name = "Grace";
      });
    });
    expect(screen.getByText("Grace:36")).toBeTruthy();
  });

  it("UU11: unwraps an array reactive to an array snapshot and stays reactive", async () => {
    const appScope = scope();
    const list = reactive([1, 2, 3]);

    function List() {
      const value = useUnit(list);
      expect(Array.isArray(value)).toBe(true);
      return createElement("span", null, value.join(","));
    }

    renderWithScope(appScope, createElement(List));
    expect(screen.getByText("1,2,3")).toBeTruthy();

    await act(async () => {
      scoped(appScope, () => {
        list[1] = 9;
      });
    });
    expect(screen.getByText("1,9,3")).toBeTruthy();
  });

  it("UU9: an object reactive read does not cause a runaway render loop despite fresh snapshot refs", async () => {
    const appScope = scope();
    const user = reactive({ a: 1, b: 2 });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    let childRenders = 0;
    let force!: (n: number) => void;
    function Parent() {
      const [n, setN] = useState(0);
      force = setN;
      return createElement(Child, { n });
    }
    function Child({ n }: { n: number }) {
      childRenders += 1;
      const value = useUnit(user);
      return createElement("span", null, `${n}:${value.a}:${value.b}`);
    }

    renderWithScope(appScope, createElement(Parent));
    const afterMount = childRenders;
    expect(screen.getByText("0:1:2")).toBeTruthy();

    // Drive several unrelated parent re-renders; each makes readStore mint a
    // fresh snapshot object, but that must not force extra store-driven renders.
    await act(async () => {
      force(1);
    });
    await act(async () => {
      force(2);
    });

    expect(screen.getByText("2:1:2")).toBeTruthy();
    // Two forced updates => at most two extra child renders (bounded, no loop).
    expect(childRenders - afterMount).toBeLessThanOrEqual(2);
    // No "getSnapshot should be cached" warning.
    const cachedWarn = warn.mock.calls.some((c) =>
      String(c[0]).includes("getSnapshot should be cached"),
    );
    expect(cachedWarn).toBe(false);
    warn.mockRestore();
  });
});

// ===========================================================================
// useUnit — shapes (array / object) + callables
// ===========================================================================

describe("useUnit / shapes", () => {
  it("UU4: a mixed array of store+event+effect resolves positionally", async () => {
    const appScope = scope();
    const bump = event<number>();
    const count = store(0);
    const doubleFx = effect(async (n: number) => n * 2);
    reaction({ on: bump, run: (n) => (count.value += n) });

    let lastResult = 0;
    function Widget() {
      const [value, inc, dbl] = useUnit([count, bump, doubleFx] as const);
      return createElement(
        "button",
        {
          onClick: async () => {
            // Await sequentially: overlapping unawaited async `scoped(...)` calls
            // interleave their restore-on-settle and corrupt core's ambient
            // scope global (see suspected core bug), which would leak into later
            // tests.
            await inc(2);
            lastResult = await dbl(10);
          },
        },
        String(value),
      );
    }

    renderWithScope(appScope, createElement(Widget));
    expect(button().textContent).toBe("0");

    await act(async () => {
      fireEvent.click(button());
    });

    expect(button().textContent).toBe("2");
    expect(lastResult).toBe(20);
  });

  it("UU5: an object shape unwraps each key identically", () => {
    const appScope = scope();
    const changed = event<string>();
    const name = store("Ada");

    let captured: { changed: unknown; name: unknown } | null = null;
    function Profile() {
      captured = useUnit({ changed, name });
      return null;
    }

    renderWithScope(appScope, createElement(Profile));
    expect(captured!.name).toBe("Ada");
    expect(typeof captured!.changed).toBe("function");
  });

  it("UU8: event/effect callback identity is stable across unrelated re-renders and changes with scope", async () => {
    const scopeA = scope();
    const scopeB = scope();
    const evt = event<void>();

    const seen: unknown[] = [];
    let force!: (n: number) => void;
    function Reader() {
      const [n, setN] = useState(0);
      force = setN;
      const cb = useUnit(evt);
      seen.push(cb);
      return createElement("span", null, String(n));
    }

    const view = renderWithScope(scopeA, createElement(Reader));
    await act(async () => {
      force(1);
    });
    // Identity stable while scope+unit unchanged.
    expect(seen[0]).toBe(seen[1]);

    // Changing the provided scope produces a new callback identity.
    view.rerender(withScope(scopeB, createElement(Reader)));
    expect(seen[seen.length - 1]).not.toBe(seen[0]);
  });

  it("UU12: growing the useUnit array length between renders throws a hooks-count error", async () => {
    const appScope = scope();
    const a = store(1);
    const b = store(2);
    const errors: Error[] = [];

    function Flipper() {
      const [big, setBig] = useState(false);
      const units = useUnit(big ? [a, b] : [a]);
      return createElement(
        "button",
        { onClick: () => setBig(true) },
        String(units.length),
      );
    }

    render(
      withScope(
        appScope,
        createElement(ErrorBoundary, { onError: (e) => errors.push(e) }, createElement(Flipper)),
      ),
    );
    expect(button().textContent).toBe("1");

    const all = await captureHookError(() => fireEvent.click(button()), errors);
    expect(all.some((e) => /hook/i.test(e.message))).toBe(true);
  });
});

// ===========================================================================
// useUnit(effect)
// ===========================================================================

describe("useUnit(effect)", () => {
  it("UU3: runs the effect in the provided scope and resolves with the done value", async () => {
    const appScope = scope();
    const otherScope = scope();
    const marker = store(0);
    const fx = effect(async (n: number) => {
      marker.value = n; // written under the effect call's scope
      return n * 2;
    });

    let resolved = 0;
    function Runner() {
      const run = useUnit(fx);
      return createElement(
        "button",
        { onClick: async () => (resolved = await run(21)) },
        "run",
      );
    }

    renderWithScope(appScope, createElement(Runner));
    await act(async () => {
      fireEvent.click(button());
    });

    expect(resolved).toBe(42);
    readIn(appScope, () => expect(marker.value).toBe(21));
    readIn(otherScope, () => expect(marker.value).toBe(0));
    readIn(appScope, () => expect(fx.inFlight.value).toBe(0));
  });

  it("UU3-wild: aborting mid-flight rejects the callback promise and fires aborted in scope", async () => {
    const appScope = scope();
    const gate = deferred<void>();
    const fx = effect(async (n: number, _ctx) => {
      await gate.promise;
      return n;
    });

    const abortedIn: number[] = [];
    reaction({
      on: fx.aborted,
      run: () => abortedIn.push(1),
    });

    let run!: (n: number, opts?: EffectCallOptions) => Promise<number>;
    function Runner() {
      run = useUnit(fx);
      return null;
    }
    renderWithScope(appScope, createElement(Runner));

    const controller = new AbortController();
    let rejected = false;
    await act(async () => {
      const p = run(7, { signal: controller.signal });
      controller.abort();
      try {
        await p;
      } catch {
        rejected = true;
      }
      gate.resolve();
    });

    expect(rejected).toBe(true);
    expect(abortedIn.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// readStore (algorithmic probes)
// ===========================================================================

describe("readStore", () => {
  it("RS1: primitive store returns the raw value", () => {
    const sc = scope();
    const count = store(5);
    expect(readStore(count as unknown as Store<number>, sc)).toBe(5);
  });

  it("RS2: object reactive returns fromEntries of non-native keys (nested object kept as value)", () => {
    const sc = scope();
    const r = reactive({ x: 1, y: { z: 2 } });
    expect(readStore(r as never, sc)).toEqual({ x: 1, y: { z: 2 } });
  });

  it("RS3: array reactive returns an Array.from snapshot", () => {
    const sc = scope();
    const a = reactive([1, 2, 3]);
    const snap = readStore(a as never, sc);
    expect(Array.isArray(snap)).toBe(true);
    expect(snap).toEqual([1, 2, 3]);
  });

  it("RS3-edge: an object with a `length` field but a non-numeric key is NOT treated as an array", () => {
    const sc = scope();
    const r = reactive({ length: 2, foo: "x" } as Record<string, unknown>);
    const snap = readStore(r as never, sc);
    expect(Array.isArray(snap)).toBe(false);
    expect(snap).toEqual({ length: 2, foo: "x" });
  });

  it("RS5: reads reflect the target scope's state, not the default", () => {
    const scopeA = scope();
    const scopeB = scope();
    const s = store(0);
    scoped(scopeA, () => (s.value = 11));
    scoped(scopeB, () => (s.value = 22));
    expect(readStore(s as unknown as Store<number>, scopeA)).toBe(11);
    expect(readStore(s as unknown as Store<number>, scopeB)).toBe(22);
  });

  // SUSPECTED BUG: a reactive field named like a StoreApi member (map/node/...)
  // makes the proxy `ownKeys` return duplicate keys, so readStore throws instead
  // of returning the snapshot. Correct behaviour would retain the field.
  it.fails("RS4: a reactive field colliding with a native store key should still be readable", () => {
    const sc = scope();
    const r = reactive({ map: 5, value: 10 } as Record<string, unknown>);
    expect(readStore(r as never, sc)).toEqual({ map: 5, value: 10 });
  });
});

// ===========================================================================
// unit predicates (isUnitLike / isStoreUnit / isPlainObject)
// ===========================================================================

describe("unit predicates", () => {
  it("distinguishes stores, callables, and plain values", () => {
    const s = store(0);
    const r = reactive({ a: 1 });
    const evt = event<void>();
    const fx = effect(async () => 1);

    expect(isStoreUnit(s)).toBe(true);
    expect(isStoreUnit(r)).toBe(true);
    expect(isStoreUnit(evt)).toBe(false);
    expect(isUnitLike(evt)).toBe(true);
    expect(isUnitLike(fx)).toBe(true);
    expect(isUnitLike({})).toBe(false);
    expect(isUnitLike(() => {})).toBe(false);

    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });
});

// ===========================================================================
// useModel — raw model object path
// ===========================================================================

describe("useModel / raw model", () => {
  it("UM1: unwraps unit fields to values and bound callbacks without creating an instance", async () => {
    const appScope = scope();
    const inc = event<void>();
    const count = store(0);
    reaction({ on: inc, run: () => (count.value += 1) });
    const model = { count, inc };

    function View() {
      const view = useModel(model);
      return createElement("button", { onClick: () => view.inc() }, String(view.count));
    }

    renderWithScope(appScope, createElement(View));
    expect(button().textContent).toBe("0");
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("1");
  });

  it("UM11: unwraps an enumerable symbol-keyed unit field", () => {
    const appScope = scope();
    const sym = Symbol("s");
    const model = { [sym]: store(7) };

    let captured: Record<PropertyKey, unknown> | null = null;
    function View() {
      captured = useModel(model) as Record<PropertyKey, unknown>;
      return null;
    }
    renderWithScope(appScope, createElement(View));
    expect(captured![sym]).toBe(7);
  });

  it("UM7/UM9/UM13: plain methods, class instances and array-of-stores fields are kept raw", () => {
    const appScope = scope();
    const greet = () => "hi";
    const when = new Date(0);
    class Tag {
      n = store(1);
    }
    const tag = new Tag();
    const items = [store(1), store(2)];
    const model = { greet, when, tag, items, count: store(3) };

    let view: any = null;
    function View() {
      view = useModel(model);
      return null;
    }
    renderWithScope(appScope, createElement(View));

    expect(view.greet).toBe(greet);
    expect(view.greet()).toBe("hi");
    expect(view.when).toBe(when);
    expect(view.tag).toBe(tag);
    expect(isStoreUnit(view.tag.n)).toBe(true); // not unwrapped
    expect(Array.isArray(view.items)).toBe(true);
    expect(isStoreUnit(view.items[0])).toBe(true); // array elements not unwrapped
    expect(view.count).toBe(3); // top-level store IS unwrapped
  });

  it("UM12: flipping a field's unit-kind (store<->event) at the same call site throws a hooks error", async () => {
    const appScope = scope();
    const asStore = { field: store(0) };
    const asEvent = { field: event<void>() };
    const errors: Error[] = [];

    function Flipper() {
      const [flip, setFlip] = useState(false);
      useModel(flip ? asEvent : asStore);
      return createElement("button", { onClick: () => setFlip(true) }, "go");
    }

    render(
      withScope(
        appScope,
        createElement(ErrorBoundary, { onError: (e) => errors.push(e) }, createElement(Flipper)),
      ),
    );

    const all = await captureHookError(() => fireEvent.click(button()), errors);
    // Flipping a field's unit-kind (store => 4 hooks via useStoreUnit, event => 1
    // hook) at the same call site violates the Rules of Hooks. React surfaces
    // this as a render crash to the error boundary (the exact message is
    // version-specific), so we assert an error was raised, not its wording.
    expect(all.length).toBeGreaterThan(0);
  });

  it("UM14: swapping factory vs raw-model branch at the same call site throws a hooks error", async () => {
    const appScope = scope();
    const rawModel = { count: store(0) };
    const factory = (_ctx: ModelContext<Record<string, never>>) => ({ count: store(0) });
    const errors: Error[] = [];

    // Start on the factory path (more hooks), flip to the raw path (fewer hooks)
    // to guarantee a "rendered fewer hooks" hard error.
    function Flipper() {
      const [asRaw, setAsRaw] = useState(false);
      if (asRaw) {
        useModel(rawModel);
      } else {
        useModel(factory, {});
      }
      return createElement("button", { onClick: () => setAsRaw(true) }, "go");
    }

    render(
      withScope(
        appScope,
        createElement(ErrorBoundary, { onError: (e) => errors.push(e) }, createElement(Flipper)),
      ),
    );

    const all = await captureHookError(() => fireEvent.click(button()), errors);
    // Factory path runs extra hooks (useModelInstance) vs the raw-model path;
    // swapping branch at one call site is a Rules-of-Hooks violation that React
    // surfaces as a render crash to the error boundary.
    expect(all.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// component() — model views, lifecycle, controlled & cached
// ===========================================================================

function counterModelFactory(lifecycle?: string[]) {
  return function createCounterModel(context: ModelContext<{ step: number }>) {
    const clicked = event<void>();
    const count = store(0);
    reaction({ on: clicked, run: () => (count.value += context.props.step) });
    if (lifecycle) {
      reaction({ on: context.mounted, run: () => lifecycle.push("mounted") });
      reaction({ on: context.unmounted, run: () => lifecycle.push("unmounted") });
    }
    return { clicked, count };
  };
}

describe("component / lifecycle & scope errors", () => {
  it("CO1: strips the `model` prop from the props forwarded to the view", () => {
    const appScope = scope();
    let seenProps: Record<string, unknown> | null = null;
    const C = component({
      model: counterModelFactory(),
      view(props: any) {
        seenProps = props;
        return null;
      },
    });
    renderWithScope(appScope, createElement(C, { step: 2 }));
    expect(seenProps).not.toBeNull();
    expect("model" in seenProps!).toBe(true); // the reactive view is passed as `model`
    expect((seenProps as any).step).toBe(2);
  });

  it("CO2: an uncontrolled component without a ScopeProvider throws", () => {
    const C = component({
      model: counterModelFactory(),
      view: () => null,
    });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(createElement(C, { step: 1 }))).toThrow(
      "[useProvidedScope] Scope is not provided",
    );
    consoleErr.mockRestore();
  });

  it("CO10: displayName is Virentia(ViewName) for a named view", () => {
    const Named = component({
      model: counterModelFactory(),
      view: function Foo() {
        return null;
      },
    });
    expect(Named.displayName).toBe("Virentia(Foo)");
  });

  // SUSPECTED BUG: getComponentName uses `view.name ?? "Component"`; `??` only
  // catches null/undefined, so an empty-string `name` slips through and yields
  // "Virentia()". `||` would be correct.
  it("CO10: an anonymous (empty-name) view should fall back to Virentia(Component)", () => {
    const anon = function () {
      return null;
    };
    Object.defineProperty(anon, "name", { value: "" });
    const Anon = component({ model: counterModelFactory(), view: anon });
    expect(Anon.displayName).toBe("Virentia(Component)");
  });

  it("LC3/LC4: an uncontrolled instance mounts, unmounts, and disposes on real unmount", async () => {
    const appScope = scope();
    const lifecycle: string[] = [];
    const C = component({
      model: counterModelFactory(lifecycle),
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });

    const view = renderWithScope(appScope, createElement(C, { step: 2 }));
    expect(lifecycle).toEqual(["mounted"]);

    await act(async () => {
      view.unmount();
    });
    // flush the deferred-dispose microtask
    await act(async () => {
      await Promise.resolve();
    });
    expect(lifecycle).toEqual(["mounted", "unmounted"]);
  });

  it("LC5: StrictMode mount/unmount/mount reuses the instance and keeps reactions alive", async () => {
    const appScope = scope();
    const lifecycle: string[] = [];
    const C = component({
      model: counterModelFactory(lifecycle),
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });

    await act(async () => {
      render(
        createElement(
          StrictMode,
          null,
          withScope(appScope, createElement(C, { step: 2 })),
        ),
      );
    });

    expect(lifecycle).toEqual(["mounted", "unmounted", "mounted"]);

    await act(async () => {
      fireEvent.click(button());
    });
    // Reaction still attached: click worked.
    expect(button().textContent).toBe("2");
  });

  it("LC2: a props change is rewritten into the props store so reactions observe it", async () => {
    const appScope = scope();
    const observed: number[] = [];
    function createModel(context: ModelContext<{ step: number }>) {
      const clicked = event<void>();
      const count = store(0);
      reaction({ on: clicked, run: () => (count.value += context.props.step) });
      return { clicked, count };
    }
    const C = component({
      model: createModel,
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });

    const view = renderWithScope(appScope, createElement(C, { step: 2 }));
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("2");

    view.rerender(withScope(appScope, createElement(C, { step: 5 })));
    await act(async () => {
      fireEvent.click(button());
    });
    // New prop observed by the reaction: 2 + 5 = 7.
    expect(button().textContent).toBe("7");
    void observed;
  });

  it("LC7: a props-only change does NOT recreate the instance", async () => {
    const appScope = scope();
    let created = 0;
    function createModel(context: ModelContext<{ step: number }>) {
      created += 1;
      const clicked = event<void>();
      const count = store(0);
      reaction({ on: clicked, run: () => (count.value += context.props.step) });
      return { clicked, count };
    }
    const C = component({
      model: createModel,
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });

    const view = renderWithScope(appScope, createElement(C, { step: 1 }));
    expect(created).toBe(1);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("1");

    view.rerender(withScope(appScope, createElement(C, { step: 9 })));
    // Same instance: count preserved, not reset.
    expect(created).toBe(1);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("10");
  });

  it("LC8: a change of provided scope recreates the model instance", async () => {
    const scopeA = scope();
    const scopeB = scope();
    let created = 0;
    function createModel(context: ModelContext<{ step: number }>) {
      created += 1;
      const clicked = event<void>();
      const count = store(0);
      reaction({ on: clicked, run: () => (count.value += context.props.step) });
      return { clicked, count };
    }
    const C = component({
      model: createModel,
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });

    const view = renderWithScope(scopeA, createElement(C, { step: 1 }));
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("1");
    expect(created).toBe(1);

    view.rerender(withScope(scopeB, createElement(C, { step: 1 })));
    expect(created).toBe(2);
    // Fresh instance in scopeB starts at 0.
    expect(button().textContent).toBe("0");
  });
});

// ===========================================================================
// component.create() — controlled models
// ===========================================================================

describe("component.create / controlled", () => {
  it("CO8: create() outside any active scope throws", () => {
    const C = component({ model: counterModelFactory(), view: () => null });
    expect(() => (C as any).create({ step: 1 })).toThrow(
      "[component.create] Parent component context is required",
    );
  });

  it("CO9: create() result exposes dispose, Symbol.dispose and keeps units raw", () => {
    const appScope = scope();
    const C = component({ model: counterModelFactory(), view: () => null });
    const m = scoped(appScope, () => (C as any).create({ step: 2 })) as ComponentModel<{
      count: Store<number>;
      clicked: EventCallable<void>;
    }>;

    expect(typeof (m as any).dispose).toBe("function");
    expect(typeof (m as any)[Symbol.dispose]).toBe("function");
    expect(isStoreUnit((m as any).count)).toBe(true); // raw store, not unwrapped
    const instance = readExposedModelInstance(m);
    expect(instance).not.toBeNull();
    expect(instance!.model).toBe(m);
    (m as any).dispose();
  });

  it("CO3: a controlled component renders with no ScopeProvider, using the model's creation scope", async () => {
    const appScope = scope();
    const C = component({
      model: counterModelFactory(),
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });
    const m = scoped(appScope, () => (C as any).create({ step: 3 }));

    render(createElement(C, { step: 3, model: m } as any));
    expect(button().textContent).toBe("0");
    await act(async () => {
      await scoped(appScope, () => (m as any).clicked());
    });
    expect(button().textContent).toBe("3");
    (m as any).dispose();
  });

  it("CO4: a controlled component given a plain-object model prop throws", () => {
    const C = component({ model: counterModelFactory(), view: () => null });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(createElement(C, { step: 1, model: { count: store(0) } } as any)),
    ).toThrow("[component] The model prop must be created with component.create().");
    consoleErr.mockRestore();
  });

  it("CO6: a controlled component does NOT dispose the instance on unmount", async () => {
    const appScope = scope();
    const C = component({
      model: counterModelFactory(),
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });
    const m = scoped(appScope, () => (C as any).create({ step: 2 }));
    const view = render(createElement(C, { step: 2, model: m } as any));

    await act(async () => {
      view.unmount();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Instance still alive: dispatch still mutates.
    await act(async () => {
      await scoped(appScope, () => (m as any).clicked());
    });
    scoped(appScope, () => expect((m as any).count.value).toBe(2));
    (m as any).dispose();
  });

  it("CO11: swapping the controlled model prop switches the rendered instance", async () => {
    const appScope = scope();
    const C = component({
      model: counterModelFactory(),
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });
    const a = scoped(appScope, () => (C as any).create({ step: 1 }));
    const b = scoped(appScope, () => (C as any).create({ step: 1 }));
    // pre-mutate A so the two instances are distinguishable
    await scoped(appScope, () => (a as any).clicked());
    await scoped(appScope, () => (a as any).clicked());

    const view = render(createElement(C, { step: 1, model: a } as any));
    expect(button().textContent).toBe("2");

    view.rerender(createElement(C, { step: 1, model: b } as any));
    expect(button().textContent).toBe("0");

    // A untouched and still alive.
    scoped(appScope, () => expect((a as any).count.value).toBe(2));
    (a as any).dispose();
    (b as any).dispose();
  });

  it("UM6/CO14: a parent embeds a child ComponentModel raw and forwards it as a controlled prop", async () => {
    const appScope = scope();
    const Child = component({
      model: counterModelFactory(),
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });
    let childModelInView: any = null;
    const Parent = component({
      model() {
        const child = (Child as any).create({ step: 2 });
        return { child };
      },
      view({ model }: any) {
        childModelInView = model.child;
        return createElement(Child, { step: 2, model: model.child });
      },
    });

    renderWithScope(appScope, createElement(Parent, {}));
    // The child is kept raw (still a ComponentModel with a raw store).
    expect(isStoreUnit(childModelInView.count)).toBe(true);
    expect(readExposedModelInstance(childModelInView)).not.toBeNull();

    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("2");
  });
});

// ===========================================================================
// cached components
// ===========================================================================

describe("component / cached", () => {
  it("CO5/CO7: a cached component reuses its instance across unmount and is not disposed on unmount", async () => {
    const appScope = scope();
    let created = 0;
    function createModel() {
      created += 1;
      const clicked = event<void>();
      const count = store(0);
      reaction({ on: clicked, run: () => (count.value += 1) });
      return { clicked, count };
    }
    const cache = createModelCache<string, { id: string }, ReturnType<typeof createModel>>();
    const C = component({
      cache,
      key: (props: { id: string }) => props.id,
      model: createModel,
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });

    const view = renderWithScope(appScope, createElement(C, { id: "a" }));
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("1");

    view.rerender(withScope(appScope, null));
    expect(cache.has("a", appScope)).toBe(true); // not disposed on unmount

    view.rerender(withScope(appScope, createElement(C, { id: "a" })));
    expect(button().textContent).toBe("1"); // state preserved
    expect(created).toBe(1);
    cache.clear();
  });

  it("CO12: a cached component's key change switches to a fresh instance and leaves the old cached", async () => {
    const appScope = scope();
    function createModel() {
      const clicked = event<void>();
      const count = store(0);
      reaction({ on: clicked, run: () => (count.value += 1) });
      return { clicked, count };
    }
    const cache = createModelCache<string, { id: string }, ReturnType<typeof createModel>>();
    const C = component({
      cache,
      key: (props: { id: string }) => props.id,
      model: createModel,
      view({ model }: any) {
        return createElement("button", { onClick: () => model.clicked() }, String(model.count));
      },
    });

    const view = renderWithScope(appScope, createElement(C, { id: "a" }));
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("1");

    view.rerender(withScope(appScope, createElement(C, { id: "b" })));
    expect(button().textContent).toBe("0"); // fresh instance for b
    expect(cache.has("a", appScope)).toBe(true); // a preserved
    expect(cache.get("a", appScope)).toBeDefined();
    scoped(appScope, () => expect(cache.get("a", appScope)!.count.value).toBe(1));
    cache.clear();
  });
});

// ===========================================================================
// model cache internals
// ===========================================================================

describe("model cache", () => {
  function cacheableInstance(sc: Scope) {
    const bump = event<void>();
    const count = store(0);
    const create = () =>
      createModelInstance(
        () => {
          reaction({ on: bump, run: () => (count.value += 1) });
          return { bump, count };
        },
        {},
        sc,
        "k",
      );
    return { bump, count, create };
  }

  it("MC1: getOrCreateCachedInstance creates once and returns the same instance", () => {
    const sc = scope();
    const cache = createModelCache<string, object, { bump: EventCallable<void>; count: Store<number> }>();
    const { create } = cacheableInstance(sc);
    const first = getOrCreateCachedInstance(cache, sc, "k", create);
    const second = getOrCreateCachedInstance(cache, sc, "k", create);
    expect(first).toBe(second);
    cache.clear();
  });

  it("MC2: the same key under two scopes yields distinct instances", () => {
    const scopeA = scope();
    const scopeB = scope();
    const cache = createModelCache<string, object, { bump: EventCallable<void>; count: Store<number> }>();
    const a = getOrCreateCachedInstance(cache, scopeA, "k", cacheableInstance(scopeA).create);
    const b = getOrCreateCachedInstance(cache, scopeB, "k", cacheableInstance(scopeB).create);
    expect(a).not.toBe(b);
    expect(cache.getInstance("k", scopeA)).toBe(a);
    expect(cache.getInstance("k", scopeB)).toBe(b);
    cache.clear();
  });

  it("MC3/MC4: scope-less lookup scans all maps; get returns model, getInstance returns instance", () => {
    const scopeA = scope();
    const scopeB = scope();
    const cache = createModelCache<string, object, { bump: EventCallable<void>; count: Store<number> }>();
    const a = getOrCreateCachedInstance(cache, scopeA, "k", cacheableInstance(scopeA).create);

    expect(cache.has("k")).toBe(true);
    expect(cache.get("k")).toBe(a.model);
    expect(cache.getInstance("k")).toBe(a);
    // wrong scope -> miss
    expect(cache.has("k", scopeB)).toBe(false);
    expect(cache.get("k", scopeB)).toBeUndefined();
    cache.clear();
  });

  it("MC5: delete(key,scope) disposes the instance, returns true, and a second delete returns false", async () => {
    const sc = scope();
    const cache = createModelCache<string, object, { bump: EventCallable<void>; count: Store<number> }>();
    const { bump, count, create } = cacheableInstance(sc);
    getOrCreateCachedInstance(cache, sc, "k", create);

    await scoped(sc, () => bump());
    scoped(sc, () => expect(count.value).toBe(1));

    expect(cache.delete("k", sc)).toBe(true);
    expect(cache.has("k", sc)).toBe(false);

    // reaction disposed: further dispatches are no-ops
    await scoped(sc, () => bump());
    scoped(sc, () => expect(count.value).toBe(1));

    expect(cache.delete("k", sc)).toBe(false);
  });

  it("MC6: delete(key) with no scope purges every scope map", () => {
    const scopeA = scope();
    const scopeB = scope();
    const cache = createModelCache<string, object, { bump: EventCallable<void>; count: Store<number> }>();
    getOrCreateCachedInstance(cache, scopeA, "k", cacheableInstance(scopeA).create);
    getOrCreateCachedInstance(cache, scopeB, "k", cacheableInstance(scopeB).create);

    expect(cache.delete("k")).toBe(true);
    expect(cache.has("k", scopeA)).toBe(false);
    expect(cache.has("k", scopeB)).toBe(false);
    expect(cache.delete("k")).toBe(false);
  });

  it("MC8: clear(scope) only clears that scope; clear() clears all", () => {
    const scopeA = scope();
    const scopeB = scope();
    const cache = createModelCache<string, object, { bump: EventCallable<void>; count: Store<number> }>();
    getOrCreateCachedInstance(cache, scopeA, "k", cacheableInstance(scopeA).create);
    getOrCreateCachedInstance(cache, scopeB, "k", cacheableInstance(scopeB).create);

    cache.clear(scopeA);
    expect(cache.has("k", scopeA)).toBe(false);
    expect(cache.has("k", scopeB)).toBe(true);

    cache.clear();
    expect(cache.has("k", scopeB)).toBe(false);
  });

  it("MC9: an unsupported cache object throws", () => {
    const sc = scope();
    expect(() =>
      getOrCreateCachedInstance({} as any, sc, "k", () => ({}) as any),
    ).toThrow("[useModel] Unsupported model cache. Use createModelCache().");
  });
});

// ===========================================================================
// scope helpers
// ===========================================================================

describe("scope helpers", () => {
  it("SC2: a nested ScopeProvider overrides the outer one for its subtree", () => {
    const scopeA = scope();
    const scopeB = scope();
    const s = store(0);
    scoped(scopeA, () => (s.value = 10));
    scoped(scopeB, () => (s.value = 20));

    function Reader() {
      return createElement("span", null, String(useUnit(s)));
    }

    render(
      withScope(scopeA, withScope(scopeB, createElement(Reader))),
    );
    expect(screen.getByText("20")).toBeTruthy();
  });

  it("SC3: useOptionalProvidedScope returns null when no provider is present", () => {
    let captured: Scope | null | undefined;
    function Reader() {
      captured = useOptionalProvidedScope();
      return null;
    }
    render(createElement(Reader));
    expect(captured).toBeNull();
  });
});

// ===========================================================================
// type-level smoke checks (a couple; the dedicated type wave covers the rest)
// ===========================================================================

describe("types (smoke)", () => {
  it("TY4/TY5: void-event and effect-options callable shapes", () => {
    const done = event<void>();
    const fx = effect(async (id: number) => id);
    expectTypeOf<UnitValue<typeof done>>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<UnitValue<typeof fx>>().parameter(1).toEqualTypeOf<EffectCallOptions | undefined>();
    expectTypeOf<UnitValue<typeof fx>>().returns.toEqualTypeOf<Promise<number>>();
  });

  it("TY6: UnitShape maps a tuple positionally", () => {
    type S = UnitShape<readonly [Store<number>, EventCallable<string>]>;
    expectTypeOf<S[0]>().toEqualTypeOf<number>();
    expectTypeOf<S[1]>().toEqualTypeOf<(payload: string) => Promise<void>>();
  });

  it("TY8/TY9/TY14: ReactiveModel omits dispose, keeps ComponentModel raw, doesn't unwrap arrays", () => {
    type WithDispose = ReactiveModel<{ count: Store<number>; dispose: () => void }>;
    expectTypeOf<keyof WithDispose>().toEqualTypeOf<"count">();

    type WithChild = ReactiveModel<{ child: ComponentModel<{ count: Store<number> }> }>;
    expectTypeOf<WithChild["child"]>().toEqualTypeOf<ComponentModel<{ count: Store<number> }>>();

    // TY14 / SUSPECTED TYPE-RUNTIME DIVERGENCE: at runtime (UM13) an array field
    // is kept RAW because `isPlainObject` rejects arrays, so its inner stores are
    // NOT unwrapped. The ReactiveModel TYPE, however, recurses into arrays (they
    // satisfy `Model[Key] extends object`), resolving to
    // `ReactiveModel<Store<number>[]>` — neither the raw `Store<number>[]` the
    // runtime yields nor a cleanly-unwrapped `number[]`. Documented, not asserted
    // as correct.
    type WithArray = ReactiveModel<{ items: Store<number>[] }>;
    expectTypeOf<WithArray["items"]>().toEqualTypeOf<Store<number>[]>();
    expectTypeOf<WithArray["items"]>().not.toEqualTypeOf<number[]>();
  });
});

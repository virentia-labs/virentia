// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { event, reaction, scope, scoped, store } from "@virentia/core";
import { useUnit } from "@virentia/vue";
import {
  defineComponent,
  h as vueH,
  nextTick,
  onMounted,
  onUnmounted,
  onScopeDispose,
  ref,
  Suspense,
  useId,
} from "vue";
import * as VueRuntime from "vue";
import { createElement as h, hydrate } from "../lib";
import { renderToString, renderToStringAsync } from "../lib/server";
import { VueTree } from "../lib/vue";
import { VueTree as ServerVueTree } from "../lib/vue-server";

// Vue's compiler emits this runtime helper, but its public declarations omit it.
const { withAsyncContext } = VueRuntime as typeof VueRuntime & {
  withAsyncContext<T>(awaitable: () => Promise<T>): [Promise<T>, () => void];
};

afterEach(() => {
  document.body.textContent = "";
});

describe("VueTree", () => {
  it.each(["before await", "after await", "child after await"])(
    "retains the snapshot when an async Suspense component binds %s",
    async (binding) => {
      const count = store(3);
      const increment = event();
      reaction({
        on: increment,
        run: () => {
          count.value += 1;
        },
      });
      let deferSetup = false;
      let resumeSetup!: () => void;
      const pendingSetup = new Promise<void>((resolve) => {
        resumeSetup = resolve;
      });
      const renders: number[] = [];
      const bindReader = () => {
        const value = useUnit(count);
        return () => {
          renders.push(value.value);
          return vueH("span", null, value.value);
        };
      };
      const Reader = defineComponent({ setup: bindReader });
      const AsyncReader = defineComponent({
        async setup() {
          if (binding === "before await") {
            const render = bindReader();
            if (deferSetup) await pendingSetup;
            return render;
          }
          if (binding === "after await") {
            // This is the context restoration emitted for script setup awaits.
            const [pending, restore] = withAsyncContext(() =>
              deferSetup ? pendingSetup : Promise.resolve(),
            );
            await pending;
            restore();
            return bindReader();
          }
          if (deferSetup) await pendingSetup;
          return () => vueH(Reader);
        },
      });
      const Writer = defineComponent({
        setup() {
          const incrementCount = useUnit(increment);
          onMounted(() => {
            void incrementCount();
          });
          return () => vueH("button", null, "increment");
        },
      });
      const view = (Tree: typeof VueTree) => () =>
        h(
          "main",
          null,
          h(Tree, { node: vueH(Suspense, null, { default: () => vueH(AsyncReader) }) }),
          h(Tree, { node: vueH(Writer) }),
        );
      const container = document.createElement("div");
      container.innerHTML = await renderToStringAsync(view(ServerVueTree), { scope: scope() });
      document.body.append(container);
      const span = container.querySelector("span");
      renders.length = 0;
      deferSetup = true;
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const appScope = scope();
      let dispose: (() => void) | undefined;
      try {
        dispose = hydrate(view(VueTree), container, { scope: appScope });
        expect(scoped(appScope, () => count.value)).toBe(4);
        expect(span?.textContent).toBe("3");
        expect(renders).toEqual([]);
        resumeSetup();
        await pendingSetup;
        await vi.waitFor(() => {
          expect(renders).toEqual([3, 4]);
        });
        expect(container.querySelector("span")).toBe(span);
        expect(span?.textContent).toBe("4");
        expect(warning).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
      } finally {
        dispose?.();
        warning.mockRestore();
        error.mockRestore();
      }
    },
  );

  it("reads live state for components first mounted after hydration", async () => {
    const count = store(3);
    const show = ref(false);
    const renders: number[] = [];
    const Reader = defineComponent({
      setup() {
        const value = useUnit(count);
        return () => {
          renders.push(value.value);
          return vueH("span", null, value.value);
        };
      },
    });
    const Parent = defineComponent({
      setup() {
        return () => vueH("main", null, show.value ? [vueH(Reader)] : []);
      },
    });
    const view = (Tree: typeof VueTree) => () => h(Tree, { node: vueH(Parent) });
    const container = document.createElement("div");
    container.innerHTML = await renderToStringAsync(view(ServerVueTree), { scope: scope() });
    document.body.append(container);
    const appScope = scope();
    const dispose = hydrate(view(VueTree), container, { scope: appScope });
    try {
      scoped(appScope, () => {
        count.value = 4;
      });
      show.value = true;
      await nextTick();
      expect(renders).toEqual([4]);
      expect(container.querySelector("span")?.textContent).toBe("4");
    } finally {
      dispose();
    }
  });

  it("hydrates each sibling from its snapshot before reconciling mounted writes", async () => {
    const count = store(3);
    const increment = event();
    reaction({
      on: increment,
      run: () => {
        count.value += 1;
      },
    });
    const renders: number[] = [];
    const Writer = defineComponent({
      setup() {
        const incrementCount = useUnit(increment);
        onMounted(() => {
          void incrementCount();
        });
        return () => vueH("button", null, "increment");
      },
    });
    const Reader = defineComponent({
      setup() {
        const value = useUnit(count);
        return () => {
          renders.push(value.value);
          return vueH("span", null, value.value);
        };
      },
    });
    const view = (Tree: typeof VueTree) => () =>
      h("main", null, h(Tree, { node: vueH(Writer) }), h(Tree, { node: vueH(Reader) }));
    const container = document.createElement("div");
    container.innerHTML = await renderToStringAsync(view(ServerVueTree), { scope: scope() });
    document.body.append(container);
    const span = container.querySelector("span");
    renders.length = 0;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const appScope = scope();
    let dispose: (() => void) | undefined;
    try {
      dispose = hydrate(view(VueTree), container, { scope: appScope });
      expect(renders[0]).toBe(3);
      await nextTick();
      expect(renders).toEqual([3, 4]);
      expect(container.querySelector("span")).toBe(span);
      expect(span?.textContent).toBe("4");
      expect(scoped(appScope, () => count.value)).toBe(4);
      expect(warning).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      dispose?.();
      warning.mockRestore();
      error.mockRestore();
    }
  });

  it("hydrates server DOM with stable IDs and preserves local state and Core scope", async () => {
    const count = store(0);
    const label = store("server");
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const Counter = defineComponent({
      props: { label: { type: String, required: true } },
      setup(props) {
        const id = useId();
        const value = useUnit(count);
        const local = ref(0);
        onMounted(mounted);
        onUnmounted(unmounted);
        return () =>
          vueH(
            "button",
            { id, onClick: () => local.value++ },
            `${props.label}:${value.value}:${local.value}`,
          );
      },
    });
    const view = (Tree: typeof VueTree) => () =>
      h(
        "main",
        null,
        h(Tree, {
          get node() {
            return vueH(Counter, { label: label.value });
          },
        }),
        h(Tree, { node: vueH(Counter, { label: "other" }) }),
      );
    const html = await renderToStringAsync(view(ServerVueTree), {
      scope: scope({ values: [[count, 3]] }),
    });
    expect(html).toContain('data-ui-ssr="vue"');
    expect(html).toContain("server:3:0");
    expect(mounted).not.toHaveBeenCalled();
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const buttons = [...container.querySelectorAll("button")];
    const ids = buttons.map((button) => button.id);
    expect(new Set(ids).size).toBe(2);
    const appScope = scope({ values: [[count, 3]] });
    const dispose = hydrate(view(VueTree), container, { scope: appScope });
    await nextTick();
    expect([...container.querySelectorAll("button")]).toEqual(buttons);
    expect(buttons.map((button) => button.id)).toEqual(ids);
    buttons[0]!.click();
    scoped(appScope, () => {
      label.value = "client";
      count.value = 4;
    });
    await nextTick();
    expect(container.querySelector("button")).toBe(buttons[0]);
    expect(buttons[0]!.textContent).toBe("client:4:1");
    dispose();
    expect(mounted).toHaveBeenCalledTimes(2);
    expect(unmounted).toHaveBeenCalledTimes(2);
  });

  it("releases SSR component effects and subscriptions, including async setup", async () => {
    const count = store(0);
    const unsubscribe = vi.fn();
    const original = count.subscribe;
    const subscribe = vi.spyOn(count, "subscribe");
    subscribe.mockImplementation((listener: Parameters<typeof original>[0]) => {
      const release = original(listener);
      return () => {
        unsubscribe();
        release();
      };
    });
    const disposed = vi.fn();
    const AsyncCounter = defineComponent({
      async setup() {
        const value = useUnit(count);
        onScopeDispose(disposed);
        await Promise.resolve();
        return () => vueH("b", null, value.value);
      },
    });
    try {
      const html = await renderToStringAsync(() => h(ServerVueTree, { node: vueH(AsyncCounter) }));
      expect(html).toContain("<b>0</b>");
      expect(subscribe).not.toHaveBeenCalled();
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(disposed).toHaveBeenCalledTimes(1);
    } finally {
      subscribe.mockRestore();
    }
  });

  it("does not subscribe functional Vue components while server rendering", async () => {
    const count = store(2);
    const subscribe = vi.spyOn(count, "subscribe");
    const FunctionalCounter = () => vueH("span", null, useUnit(count).value);
    try {
      const html = await renderToStringAsync(() =>
        h(ServerVueTree, { node: vueH(FunctionalCounter) }),
      );
      expect(html).toContain("<span>2</span>");
      expect(subscribe).not.toHaveBeenCalled();
    } finally {
      subscribe.mockRestore();
    }
  });

  it("cleans later component scopes when an earlier cleanup throws", async () => {
    const disposed = vi.fn();
    const cleanupError = new Error("cleanup failed");
    const BrokenCleanup = defineComponent({
      setup() {
        onScopeDispose(() => {
          throw cleanupError;
        });
        return () => vueH("span", null, "first");
      },
    });
    const LaterCleanup = defineComponent({
      setup() {
        onScopeDispose(disposed);
        return () => vueH("span", null, "second");
      },
    });
    const result = renderToStringAsync(() =>
      h(ServerVueTree, {
        node: vueH("main", null, [vueH(BrokenCleanup), vueH(LaterCleanup)]),
      }),
    );
    await expect(result).rejects.toThrow("Server cleanup failed");
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("preserves the render error alongside cleanup failures", async () => {
    const renderError = new Error("render failed");
    const cleanupError = new Error("cleanup failed");
    const Broken = defineComponent({
      setup() {
        onScopeDispose(() => {
          throw cleanupError;
        });
        return () => {
          throw renderError;
        };
      },
    });
    const result = renderToStringAsync(() => h(ServerVueTree, { node: vueH(Broken) }));
    await expect(result).rejects.toMatchObject({
      message: "[ui/vue] Server rendering and cleanup failed",
      errors: [expect.objectContaining({ errors: [renderError] }), cleanupError],
    });
  });

  it("cleans rejected async setups and surfaces their error", async () => {
    const disposed = vi.fn();
    const Broken = defineComponent({
      async setup() {
        onScopeDispose(disposed);
        await Promise.resolve();
        throw new Error("setup failed");
      },
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        renderToStringAsync(() => h(ServerVueTree, { node: vueH(Broken) })),
      ).rejects.toThrow("Server rendering failed");
      expect(disposed).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it("skips Vue SSR when explicitly disabled and rejects accidental synchronous rendering", () => {
    const setup = vi.fn(() => () => vueH("b", null, "client only"));
    const Counter = defineComponent({ setup });
    const html = renderToString(() => h(ServerVueTree, { node: vueH(Counter), ssr: false }));
    expect(html).toContain("<div></div>");
    expect(html).not.toContain("data-ui-ssr");
    expect(() => renderToString(() => h(ServerVueTree, { node: vueH(Counter) }))).toThrow(
      "renderToStringAsync",
    );
    expect(setup).not.toHaveBeenCalled();
  });

  it("shares the Core scope, updates a Vue VNode and releases the app on disposal", async () => {
    const count = store(0);
    const label = store("first");
    const mounted = vi.fn();
    const unmounted = vi.fn();

    const Counter = defineComponent({
      props: { label: { type: String, required: true } },
      setup(props) {
        const value = useUnit(count);
        onMounted(mounted);
        onUnmounted(unmounted);
        return () => vueH("button", null, `${props.label}:${value.value}`);
      },
    });

    const view = () =>
      h(
        "main",
        null,
        h(VueTree, {
          as: "section",
          get node() {
            return vueH(Counter, { label: label.value });
          },
        }),
        h("span", null, () => label.value),
      );

    const html = renderToString(view, { scope: scope() });
    expect(html).toContain("<section></section>");
    expect(html).not.toContain("first:0"); // Vue subtree is client-only SSR.
    expect(mounted).not.toHaveBeenCalled();

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const host = container.querySelector("section")!;
    const native = container.querySelector("span")!;
    const appScope = scope({ values: [[count, 3]] });
    const dispose = hydrate(view, container, { scope: appScope });
    await nextTick();

    expect(container.querySelector("section")).toBe(host);
    expect(container.querySelector("span")).toBe(native);
    const button = host.querySelector("button")!;
    expect(button.textContent).toBe("first:3");
    expect(mounted).toHaveBeenCalledTimes(1);

    scoped(appScope, () => {
      count.value = 4;
      label.value = "second";
    });
    await nextTick();
    expect(host.querySelector("button")).toBe(button);
    expect(button.textContent).toBe("second:4");
    expect(native.textContent).toBe("second");
    expect(mounted).toHaveBeenCalledTimes(1);

    dispose();
    expect(unmounted).toHaveBeenCalledTimes(1);
    expect(host.isConnected).toBe(false);
  });
});

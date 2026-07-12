import { mount } from "@vue/test-utils";
import { defineComponent, h, type Component } from "vue";
import type { scope } from "@virentia/core";
import { ScopeProvider } from "../../lib";

// Wrappers mounted through these helpers are tracked here so a test's afterEach
// can tear them all down via unmountAll().
const wrappers: Array<{ unmount(): void }> = [];

export function mountWithScope(appScope: ReturnType<typeof scope>, inner: Component, props?: object) {
  return mountHost(() => h(ScopeProvider, { scope: appScope }, { default: () => h(inner, props) }));
}

export function mountHost(render: () => unknown) {
  const Host = defineComponent({
    setup() {
      return () => render();
    },
  });
  const wrapper = mount(Host);

  wrappers.push(wrapper);

  return wrapper;
}

export function unmountAll() {
  while (wrappers.length) {
    wrappers.pop()?.unmount();
  }
}

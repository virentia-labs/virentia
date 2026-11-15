import type { Scope } from "@virentia/core";
import { ScopeProvider, type ScopeHydration } from "@virentia/vue";
import { createApp, createSSRApp, defineComponent, h, shallowRef, type VNode } from "vue";
import { foreignTree } from "./foreign-tree";
import { contextualElementId, type ForeignRoot } from "./native-runtime";
import type { Child, ForeignHostTag } from "./types";

export interface VueTreeProps {
  /** Create with `h(Component, props)` or another Vue VNode factory. */
  node: VNode | null;
  /** Ordinary non-void HTML host tag. Defaults to `div`. */
  as?: ForeignHostTag;
  /** Render Vue HTML on the server. Defaults to true in the server entry. */
  ssr?: boolean;
}

export function createVueBridge(
  node: VNode | null,
  scope: Scope,
  idPrefix: string,
  ssr: boolean,
  hydrationScope?: Scope,
) {
  const current = shallowRef(node);
  const hydrationListeners = new Set<() => void>();
  const hydration: (ScopeHydration & { active: boolean }) | undefined = hydrationScope
    ? {
        scope: hydrationScope,
        active: true,
        onEnd(listener) {
          hydrationListeners.add(listener);
          return () => {
            hydrationListeners.delete(listener);
          };
        },
      }
    : undefined;
  const BridgeRoot = defineComponent({
    name: "VirentiaVueTree",
    setup() {
      return () =>
        h(
          ScopeProvider,
          { scope, hydration },
          { default: () => (current.value ? [current.value] : []) },
        );
    },
  });
  const app = (ssr ? createSSRApp : createApp)(BridgeRoot);
  app.config.idPrefix = idPrefix;
  return {
    app,
    current,
    endHydration() {
      if (!hydration?.active) return;
      hydration.active = false;
      for (const listener of hydrationListeners) listener();
      hydrationListeners.clear();
    },
  };
}

export function createVueTree(
  props: VueTreeProps,
  serverRender?: (node: VNode | null, scope: Scope, idPrefix: string) => Promise<string>,
): Child {
  const idPrefix = `${contextualElementId("vue")}:vue:`;
  return foreignTree<VNode | null>({
    kind: "vue",
    asyncServerRender: true,
    get as() {
      return props.as;
    },
    get node() {
      return props.node;
    },
    get serverRender() {
      return serverRender && props.ssr !== false
        ? (node: VNode | null, scope: Scope) => serverRender(node, scope, idPrefix)
        : undefined;
    },
    mount(host, node, scope, options): ForeignRoot<VNode | null> {
      const { app, current, endHydration } = createVueBridge(
        node,
        scope,
        idPrefix,
        options.hydrate,
        options.hydrationScope,
      );
      try {
        app.mount(host);
      } catch (error) {
        app.unmount();
        throw error;
      } finally {
        endHydration();
      }
      return {
        update(next) {
          current.value = next;
        },
        dispose() {
          app.unmount();
        },
      };
    },
  });
}

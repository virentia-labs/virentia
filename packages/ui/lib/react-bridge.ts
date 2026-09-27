import type { Scope } from "@virentia/core";
import { ScopeProvider } from "@virentia/react";
import { createElement, useEffect, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { foreignTree, useId, type ForeignRoot } from "./runtime";
import type { Child, ForeignHostTag } from "./types";

export interface ReactTreeProps {
  /** A React element or any other React renderable node. */
  node: ReactNode;
  /** Ordinary non-void HTML host tag. Defaults to `div`. */
  as?: ForeignHostTag;
  /** Render React HTML on the server. Defaults to true in the server entry. */
  ssr?: boolean;
}

// Use the same component structure on both sides so React's useId paths match.
export function ReactBridge(props: {
  scope: Scope;
  hydrationScope?: Scope;
  node: ReactNode;
  committed?: () => void;
}): ReactNode {
  useEffect(() => props.committed?.(), []);
  return createElement(
    ScopeProvider,
    { scope: props.scope, hydrationScope: props.hydrationScope },
    props.node,
  );
}

export function createReactTree(
  props: ReactTreeProps,
  serverRender?: (node: ReactNode, scope: Scope, identifierPrefix: string) => string,
): Child {
  const identifierPrefix = `${useId()}:react:`;
  return foreignTree<ReactNode>({
    kind: "react",
    get as() {
      return props.as;
    },
    get node() {
      return props.node;
    },
    get serverRender() {
      return serverRender && props.ssr !== false
        ? (node: ReactNode, scope: Scope) => serverRender(node, scope, identifierPrefix)
        : undefined;
    },
    mount(host, node, scope, options): ForeignRoot<ReactNode> {
      let committed = !options.hydrate;
      let disposed = false;
      let pending = false;
      let latest = node;
      let root: Root;
      const wrap = (next: ReactNode) =>
        createElement(ReactBridge, {
          scope,
          hydrationScope: options.hydrationScope,
          node: next,
          committed() {
            if (disposed) return;
            committed = true;
            if (pending) {
              pending = false;
              root.render(wrap(latest));
            }
          },
        });
      if (options.hydrate) {
        flushSync(() => {
          root = hydrateRoot(host, wrap(node), {
            identifierPrefix,
            onRecoverableError(error) {
              // Cancelling before the first commit is an ordinary owner disposal.
              // React otherwise reports this as an early hydration update.
              if (disposed) return;
              if (typeof globalThis.reportError === "function") globalThis.reportError(error);
              else console.error(error);
            },
          });
        });
      } else {
        root = createRoot(host, { identifierPrefix });
        try {
          root.render(wrap(node));
        } catch (error) {
          root.unmount();
          throw error;
        }
      }
      return {
        update(next) {
          latest = next;
          // An early root.render would abandon hydration and replace server DOM.
          if (!committed) pending = true;
          else root.render(wrap(next));
        },
        dispose() {
          disposed = true;
          root.unmount();
        },
      };
    },
  });
}

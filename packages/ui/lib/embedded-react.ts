import { scope as createScope, type Scope } from "@virentia/core";
import { modelInstanceBindingOf } from "@virentia/core/internal";
import { useOptionalProvidedScope } from "@virentia/react";
import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type ComponentType,
} from "react";
import { requireComponentRoot } from "./embedded-root";
import { mountEmbedded, type EmbeddedProps } from "./embedded";
import type { Component } from "./types";

const useCommitEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Embed a native Virentia component in React without adding a wrapper element.
 * React owns the compiled root's placement; Virentia owns its attributes and
 * contents. The server emits the empty root and setup runs only after commit.
 */
export function asReact<P extends object>(view: Component<P>): ComponentType<EmbeddedProps<P>> {
  const rootTag = requireComponentRoot(view);

  function EmbeddedReact(props: EmbeddedProps<P>) {
    const providedScope = useOptionalProvidedScope();
    const identifierPrefix = useId();
    const host = useRef<Element | null>(null);
    const localScope = useRef<Scope | null>(null);
    const mounted = useRef<{
      instance: ReturnType<typeof mountEmbedded<P>>;
      scope: Scope;
    } | null>(null);

    const dispose = useCallback(() => {
      const current = mounted.current;
      mounted.current = null;
      current?.instance.dispose();
    }, []);

    // Ref detachment precedes removal of the host. Also handle React 19's ref
    // replay; layout-effect cleanup below covers React 18's StrictMode replay.
    const attach = useCallback(
      (element: Element | null) => {
        if (host.current === element) return;
        dispose();
        host.current = element;
      },
      [dispose],
    );

    // Never publish render-time props: React may suspend or abandon that render.
    useCommitEffect(() => {
      if (!host.current) return;
      const scope = providedScope ?? modelInstanceBindingOf(Reflect.get(props, "model"))?.homeScope ?? (localScope.current ??= createScope());
      if (mounted.current && mounted.current.scope !== scope) dispose();
      if (!mounted.current) {
        mounted.current = {
          instance: mountEmbedded(view, props, host.current, { scope, identifierPrefix }),
          scope,
        };
      } else {
        mounted.current.instance.update(props);
      }
    });

    useCommitEffect(() => dispose, [dispose]);

    // Preserve the host element identity as well as its DOM node. React's
    // special input/select update paths must not reset Virentia-owned fields.
    return useMemo(() => createElement(rootTag, { ref: attach }), [attach]);
  }

  EmbeddedReact.displayName = `Virentia(${view.name || "Component"})`;
  return EmbeddedReact;
}

import type { Scope } from "@virentia/core";
import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

const ScopeContext = createContext<Scope | null>(null);
const HydrationScopeContext = createContext<{
  scope: Scope;
  hydrationScope?: Scope;
} | null>(null);
const subscribeToHydration = () => () => {};
const clientSnapshot = () => false;
const serverSnapshot = () => true;

export function ScopeProvider(props: {
  scope: Scope;
  /** Frozen initial state for SSR hydration; events and subscriptions use the live scope. */
  hydrationScope?: Scope;
  children?: ReactNode;
}): ReactNode {
  // A Suspense boundary may hydrate long after this provider commits. Keep the
  // initial snapshot available for every descendant's own hydration phase.
  const hydration = useMemo(
    () => ({ scope: props.scope, hydrationScope: props.hydrationScope }),
    [props.scope, props.hydrationScope],
  );
  return createElement(
    ScopeContext.Provider,
    { value: props.scope },
    createElement(HydrationScopeContext.Provider, { value: hydration }, props.children),
  );
}

/** @internal Immutable snapshot for useSyncExternalStore's getServerSnapshot. */
export function useHydrationScope(scope: Scope): Scope | undefined {
  const hydration = useContext(HydrationScopeContext);
  return hydration?.scope === scope ? hydration.hydrationScope : undefined;
}

/** @internal Track hydration at the consuming component, including delayed boundaries. */
export function useStoreReadScope(scope: Scope): Scope {
  const hydrationScope = useHydrationScope(scope);
  const hydrating = useSyncExternalStore(subscribeToHydration, clientSnapshot, serverSnapshot);
  return hydrating ? (hydrationScope ?? scope) : scope;
}

export function useProvidedScope(): Scope {
  const scope = useContext(ScopeContext);

  if (!scope) {
    throw new Error("[useProvidedScope] Scope is not provided. Wrap your tree with ScopeProvider.");
  }

  return scope;
}

export function useOptionalProvidedScope(): Scope | null {
  return useContext(ScopeContext);
}

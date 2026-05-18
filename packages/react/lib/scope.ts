import type { Scope } from "@virentia/core";
import { createContext, createElement, useContext, type ReactNode } from "react";

const ScopeContext = createContext<Scope | null>(null);

export function ScopeProvider(props: { scope: Scope; children?: ReactNode }): ReactNode {
  return createElement(ScopeContext.Provider, { value: props.scope }, props.children);
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

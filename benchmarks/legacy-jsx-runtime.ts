// Benchmark-only reference: JSX key handling before the shared-key adapter.
import { createElement, Fragment, mergeProps } from "../packages/ui/lib/runtime";
import type { Component, ElementDescriptor } from "../packages/ui/lib/types";

export { Fragment };

export function jsx(
  type: string | Component<any> | symbol,
  props: Record<string, unknown> | null,
  key?: string | number | symbol,
): ElementDescriptor {
  if (key === undefined) return createElement(type, props);
  return createElement(type, mergeProps(props ?? {}, { key }));
}

export const jsxs = jsx;

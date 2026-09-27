import { createElement, Fragment, mergeProps } from "./runtime";
import type { Component, ElementDescriptor } from "./types";

export { Fragment };
export type { JSX } from "./types";

/** The compiler supplies getters for reactive props; preserve their descriptors. */
export function jsx(
  type: string | Component<any> | symbol,
  props: Record<string, unknown> | null,
  key?: string | number | symbol,
): ElementDescriptor {
  if (key === undefined) return createElement(type, props);
  return createElement(type, mergeProps(props ?? {}, { key }));
}

export const jsxs = jsx;

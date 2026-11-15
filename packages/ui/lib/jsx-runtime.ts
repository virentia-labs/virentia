import { describe, Fragment, keyedElement } from "./descriptions";
import type { Component, ElementDescriptor } from "./types";

export { Fragment };
/** @internal Targets of `@virentia/ui/vite`'s template compilation. */
export { jsxFromTemplate, jsxMember, jsxTemplate } from "./native-runtime";
export type { JSX } from "./types";

/** Standard automatic JSX runtime; store and accessor props remain ordinary JavaScript. */
export function jsx(
  type: string | Component<any> | symbol,
  props: Record<string, unknown> | null,
  key?: string | number | symbol,
): ElementDescriptor {
  if (key === undefined) return describe(type, props);
  return keyedElement(type, props, key);
}

export const jsxs = jsx;

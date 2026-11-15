import { componentRootOf } from "./component";
import type { Component } from "./types";

// React can hoist metadata/resources or reuse document singletons; template
// content also has different DOM ownership. An embedded root must instead be
// an ordinary, locally positioned element owned exclusively by this instance.
const nonLocalRoots = new Set([
  "html",
  "head",
  "body",
  "base",
  "title",
  "meta",
  "link",
  "style",
  "script",
  "template",
]);

/** @internal Validate a root without executing component setup. */
export function requireComponentRoot(view: Component<any>): string {
  const tag = componentRootOf(view);
  if (!tag) {
    throw new Error(
      '[ui/embedded] A component with one stable intrinsic root is required. Declare component({ model, view, root: "button" }).',
    );
  }
  if (!/^[a-z][a-zA-Z0-9._-]*$/.test(tag) || nonLocalRoots.has(tag)) {
    throw new Error(
      `[ui/embedded] <${tag}> is not a supported embedded root. Document, resource, template and namespaced-tag roots cannot be owned as ordinary local elements.`,
    );
  }
  return tag;
}

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createReactTree, ReactBridge, type ReactTreeProps } from "./react-bridge";
import type { Child } from "./types";

export type { ReactTreeProps } from "./react-bridge";

/** Server entry selected automatically by the package's Node export condition. */
export function ReactTree(props: ReactTreeProps): Child {
  return createReactTree(props, (node, scope, identifierPrefix) =>
    renderToString(createElement(ReactBridge, { node, scope }), { identifierPrefix }),
  );
}

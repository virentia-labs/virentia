import { createReactTree, type ReactTreeProps } from "./react-bridge";
import type { Child } from "./types";

export type { ReactTreeProps } from "./react-bridge";

/** Render a React tree inside Virentia, reusing its server HTML when present. */
export function ReactTree(props: ReactTreeProps): Child {
  return createReactTree(props);
}

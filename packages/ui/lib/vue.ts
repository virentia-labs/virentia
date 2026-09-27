import { createVueTree, type VueTreeProps } from "./vue-bridge";
import type { Child } from "./types";

export type { VueTreeProps } from "./vue-bridge";

/** Render a Vue tree inside Virentia, reusing its server HTML when present. */
export function VueTree(props: VueTreeProps): Child {
  return createVueTree(props);
}

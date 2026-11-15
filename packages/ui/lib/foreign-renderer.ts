import { mountForeign } from "./foreign-mount";

export let foreignMount: typeof mountForeign | undefined;

/** A live internal producer keeps registration reachable during tree shaking. */
export function withForeignRenderer<T>(value: T): T {
  foreignMount = mountForeign;
  return value;
}

// Public surface. Kernel low-level building blocks (node, run, context,
// withContexts, transaction/tracking primitives) live in @virentia/core/internal
// — only their types are public here (e.g. `Node`, which appears on every unit
// as `.node`).
export type * from "./kernel";
export * from "./graph";
export * from "./scope";
export * from "./units";

// Where contained observer failures are reported. Apps wire this to their crash
// reporter; the default prints a readable report to the console.
export { setErrorReporter } from "./kernel/report";
export type { VirentiaErrorReporter, VirentiaFailureReport } from "./kernel/report";

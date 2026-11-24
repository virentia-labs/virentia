// Internal compatibility entry; native and server APIs use their own modules.
export * from "./native-runtime";
export { renderBase as render, hydrateBase as hydrate, attachComponentRootBase as attachComponentRoot } from "./native-runtime";
export { foreignTree } from "./foreign-tree";

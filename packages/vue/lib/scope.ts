import type { Scope } from "@virentia/core";
import { defineComponent, inject, provide, type InjectionKey, type PropType } from "vue";

const scopeKey: InjectionKey<Scope> = Symbol("virentia.vue.scope");

/** Provide a scope to the current component's subtree. Call inside `setup`. */
export function provideScope(scope: Scope): void {
  provide(scopeKey, scope);
}

export function useProvidedScope(): Scope {
  const scope = inject(scopeKey, null);

  if (!scope) {
    throw new Error("[useProvidedScope] Scope is not provided. Wrap your tree with ScopeProvider.");
  }

  return scope;
}

export function useOptionalProvidedScope(): Scope | null {
  return inject(scopeKey, null);
}

export const ScopeProvider = defineComponent({
  name: "ScopeProvider",
  props: {
    scope: {
      type: Object as PropType<Scope>,
      required: true,
    },
  },
  setup(props, { slots }) {
    provideScope(props.scope);

    return () => slots.default?.();
  },
});

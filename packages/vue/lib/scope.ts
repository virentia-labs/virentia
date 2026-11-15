import type { Scope } from "@virentia/core";
import {
  defineComponent,
  getCurrentInstance,
  inject,
  provide,
  type InjectionKey,
  type PropType,
} from "vue";

const scopeKey: InjectionKey<Scope> = Symbol("virentia.vue.scope");
const hydrationKey: InjectionKey<{ scope: Scope; hydration: ScopeHydration } | null> =
  Symbol("virentia.vue.hydration");

/** A render snapshot used only while a server-rendered tree is hydrating. */
export interface ScopeHydration {
  readonly scope: Scope;
  readonly active: boolean;
  onEnd(listener: () => void): () => void;
}

/** Provide a scope to the current component's subtree. Call inside `setup`. */
export function provideScope(scope: Scope, hydration?: ScopeHydration): void {
  provide(scopeKey, scope);
  provide(hydrationKey, hydration ? { scope, hydration } : null);
}

export function useOptionalHydration(scope: Scope): ScopeHydration | undefined {
  if (!getCurrentInstance()) return;
  const context = inject(hydrationKey, null);
  return context?.scope === scope ? context.hydration : undefined;
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

export const ScopeProvider = /* @__PURE__ */ defineComponent({
  name: "ScopeProvider",
  props: {
    scope: {
      type: Object as PropType<Scope>,
      required: true,
    },
    hydration: {
      type: Object as PropType<ScopeHydration>,
      required: false,
    },
  },
  setup(props, { slots }) {
    provideScope(props.scope, props.hydration);

    return () => slots.default?.();
  },
});

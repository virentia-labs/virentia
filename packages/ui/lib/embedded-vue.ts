import { scope as createScope } from "@virentia/core";
import { modelInstanceBindingOf } from "@virentia/core/internal";
import { useOptionalProvidedScope } from "@virentia/vue";
import {
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  useId,
  type DefineComponent,
} from "vue";
import { requireComponentRoot } from "./embedded-root";
import { mountEmbedded, type EmbeddedProps } from "./embedded";
import type { Component } from "./types";

/**
 * Embed a native Virentia component in Vue without adding a wrapper element.
 * Vue owns the compiled root's placement; Virentia owns its attributes and
 * contents. The server emits the empty root and setup runs only after commit.
 */
export function asVue<P extends object>(view: Component<P>): DefineComponent<EmbeddedProps<P>> {
  const tag = requireComponentRoot(view);

  return defineComponent({
    name: `Virentia(${view.name || "Component"})`,
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      let scope = useOptionalProvidedScope();
      const identifierPrefix = useId();
      let host: Element | null = null;
      let mounted: ReturnType<typeof mountEmbedded<P>> | undefined;
      const snapshot = () => ({ ...attrs }) as P;

      onMounted(() => {
        if (host) {
          scope ??= modelInstanceBindingOf(Reflect.get(attrs, "model"))?.homeScope ?? createScope();
          mounted = mountEmbedded(view, snapshot(), host, { scope, identifierPrefix });
        }
      });
      // attrs always contains the latest inputs, including callbacks and removed
      // props. Publish them only after Vue commits its parent update.
      onUpdated(() => mounted?.update(snapshot()));
      onBeforeUnmount(() => {
        const current = mounted;
        mounted = undefined;
        current?.dispose();
      });

      const attach = (element: unknown) => {
        host = element as Element | null;
      };
      return () => {
        if (Object.keys(slots).length > 0) {
          throw new Error(
            "[ui] asVue does not render Vue slots. Pass native Virentia children through the children prop instead.",
          );
        }
        return h(tag, { ref: attach });
      };
    },
  }) as unknown as DefineComponent<EmbeddedProps<P>>;
}

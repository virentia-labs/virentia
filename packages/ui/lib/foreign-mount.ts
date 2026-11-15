import { captureScopeSnapshot } from "@virentia/core/internal";
import type { ForeignProps, ForeignRoot } from "./builtin-descriptions";
import { foreignHostTag, childContext, insert, hydrationMismatch, assertHydrated, bind, queueMount, type Parent, type UIContext } from "./native-runtime";
export function mountForeign(
  props: ForeignProps<unknown>,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
): void {
  const tag = foreignHostTag(props.as, ctx.namespace);
  const child = childContext(ctx);
  const host = insert(ctx.document!.createElement(tag), parent, before, child);
  const serverKind = ctx.root.hydration?.active ? host.getAttribute("data-ui-ssr") : null;
  const hydrateForeign = serverKind !== null;
  if (hydrateForeign && serverKind !== (props.kind ?? "foreign")) {
    hydrationMismatch(`a ${props.kind ?? "foreign"} SSR host`);
  }
  // Foreign HTML is opaque to native hydration. Client-only hosts must still be
  // empty; the bridge starts only after the entire native tree has been claimed.
  if (!hydrateForeign) assertHydrated(host, null, child);

  let value: unknown;
  let initialValue: unknown;
  let initialized = false;
  let root: ForeignRoot<unknown> | undefined;
  bind(
    child,
    () => props.node,
    (next) => {
      if (!initialized) {
        initialized = true;
        initialValue = next;
      }
      value = next;
      root?.update(next);
    },
  );
  const hydrationScope = hydrateForeign ? captureScopeSnapshot(child.scope) : undefined;
  queueMount(
    child,
    () => {
      root = props.mount(host, hydrateForeign ? initialValue : value, child.scope, {
        hydrate: hydrateForeign,
        hydrationScope,
      });
      try {
        if (hydrateForeign && !Object.is(value, initialValue)) root.update(value);
      } catch (error) {
        const mounted = root;
        root = undefined;
        try {
          mounted.dispose();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "[ui] Foreign hydration update failed");
        }
        throw error;
      }
      return () => {
        const mounted = root;
        root = undefined;
        mounted?.dispose();
      };
    },
    hydrateForeign,
  );
}

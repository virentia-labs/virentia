import { scoped, type Scope } from "@virentia/core";
import { modelInstanceBindingOf, node, runDetached, trackNode } from "@virentia/core/internal";
import { componentMetadataOf } from "./component";
import { requireComponentRoot } from "./embedded-root";
import { attachComponentRootBase as attachComponentRoot } from "./native-runtime";
import type { Component } from "./types";

export interface EmbeddedMount<P extends object> {
  update(props: P): void | Promise<void>;
  dispose(): Promise<void>;
}
export type EmbeddedProps<P extends object> = P & { id?: string };
const closingHosts = new WeakMap<Element, Promise<void>>();

/** Commit bridge: the host owns placement, the native renderer owns its contents. */
export function mountEmbedded<P extends object>(
  view: Component<P>, props: NoInfer<P>, host: Element,
  options: { scope: Scope; identifierPrefix: string },
): EmbeddedMount<P> {
  if (requireComponentRoot(view) !== host.localName)
    throw new TypeError("[ui/embedded] The host must match the component's declared root tag");
  const metadata = componentMetadataOf(view);
  const identity = (value: P): string => {
    const model = Reflect.get(value, "model");
    const binding = modelInstanceBindingOf(model);
    if (binding && binding.homeScope !== options.scope)
      throw new Error("[ui] Supplied model belongs to a different render scope");
    const supplied = binding ? Reflect.get(model as object, "id") : Reflect.get(value, "id");
    const id = supplied ?? scoped(options.scope, () =>
      metadata?.model.idFromProps?.(value as never) ?? metadata?.id?.(value as never))
      ?? `ui:${encodeURIComponent(options.identifierPrefix)}.0`;
    if (typeof id !== "string" || !id.length) throw new TypeError("[ui] Component id must be a non-empty creation string");
    return id;
  };
  const start = (initial: P) => {
    const changed = node();
    let current = initial;
    const read = () => { trackNode(changed); return current; };
    const live = new Proxy({} as P, {
      get: (_target, key) => key === "id" && !Reflect.has(read(), key) ? identity(read()) : Reflect.get(read(), key),
      has: (_target, key) => key === "id" || Reflect.has(read(), key),
      ownKeys: () => [...new Set([...Reflect.ownKeys(read()), "id"])],
      getOwnPropertyDescriptor: (_target, key) =>
        key === "id" || Object.hasOwn(read(), key) ? { configurable: true, enumerable: true } : undefined,
      set() { throw new TypeError("[ui/embedded] Props are read-only"); },
    });
    const detach = attachComponentRoot(view, live, host, options);
    return {
      get current() { return current; }, detach,
      publish(next: P) { current = next; runDetached({ unit: changed, scope: options.scope }); },
    };
  };
  let desired = snapshot(props);
  let id = identity(desired);
  let disposed = false;
  let binding: ReturnType<typeof start> | undefined;
  let pending: Promise<void> | undefined;
  const afterClosing = closingHosts.get(host);
  if (afterClosing) {
    pending = afterClosing.then(() => { if (!disposed) { id = identity(desired); binding = start(desired); } });
    pending = pending.finally(() => { pending = undefined; });
    void pending.catch(() => {});
  } else binding = start(desired);
  const close = (): Promise<void> => {
    const completion = binding?.detach() ?? pending ?? Promise.resolve();
    binding = undefined;
    closingHosts.set(host, completion);
    void completion.finally(() => { if (closingHosts.get(host) === completion) closingHosts.delete(host); }).catch(() => {});
    return completion;
  };
  return {
    update(nextProps) {
      if (disposed) return;
      const next = snapshot(nextProps);
      const nextId = identity(next); // scope/identity validation precedes outgoing DOM changes
      if (sameProps(desired, next)) return pending;
      desired = next;
      if (pending) return pending;
      if (nextId === id) { binding!.publish(next); return; }
      pending = close().then(() => {
        if (disposed) return;
        id = identity(desired);
        binding = start(desired);
      }).finally(() => { pending = undefined; });
      void pending.catch(() => {});
      return pending;
    },
    dispose() {
      if (disposed) return pending ?? Promise.resolve();
      disposed = true;
      return close();
    },
  };
}
function snapshot<P extends object>(props: P): P {
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(props)) {
    if (Object.prototype.propertyIsEnumerable.call(props, key)) result[key] = Reflect.get(props, key);
  }
  return result;
}
function sameProps(left: object, right: object): boolean {
  const keys = Reflect.ownKeys(left);
  return keys.length === Reflect.ownKeys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && Object.is(Reflect.get(left, key), Reflect.get(right, key)));
}

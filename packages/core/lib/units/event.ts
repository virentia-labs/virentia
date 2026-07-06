import { createNode, run } from "../kernel";
import type { Node } from "../kernel";
import { describeNode, readInspectorNodeMeta, withInspectorMeta } from "../kernel/inspector";
import { requireActiveScope } from "../scope/internal";
import { registerCleanup } from "../graph/owner";

export type EventPayload<T> = undefined extends T ? [payload?: T] : [payload: T];

export interface Event<T = void> {
  readonly node: Node;
  map<Next>(fn: (value: T) => Next): Event<Next>;
  filter(fn: (value: T) => boolean): Event<T>;
  filterMap<Next>(fn: (value: T) => Next | undefined): Event<Next>;
}

export interface EventCallable<T = void> extends Event<T> {
  (...payload: EventPayload<T>): Promise<void>;
}

export interface EventDevtoolsOptions {
  name?: string;
  key?: boolean;
}

export function event<T = void>(name?: string): EventCallable<T>;
export function event<T = void>(devtools?: EventDevtoolsOptions): EventCallable<T>;
export function event<T = void>(devtools?: string | EventDevtoolsOptions): EventCallable<T> {
  return createEvent<T>(devtools) as EventCallable<T>;
}

function createEvent<T>(devtools?: string | EventDevtoolsOptions): Event<T> {
  const options = normalizeDevtoolsOptions(devtools);
  const node = createNode({
    meta: withInspectorMeta(undefined, {
      type: "event",
      name: options.name,
      key: options.key,
      callable: true,
    }),
  });

  const append = (next: Node): void => {
    node.next = node.next ?? [];
    node.next.push(next);

    registerCleanup(() => {
      const nextNodes = node.next;
      if (!nextNodes) return;

      const index = nextNodes.indexOf(next);

      if (index >= 0) {
        nextNodes.splice(index, 1);
      }
    });
  };

  const result = Object.assign(
    (...payload: EventPayload<T>) =>
      run({
        unit: node,
        payload: payload[0],
        scope: requireActiveScope(() => `call ${describeNode(node)}`),
      }),
    {
      node,

      map<Next>(fn: (value: T) => Next): Event<Next> {
        const mapped = createEvent<Next>(deriveName(node, "map"));

        append(
          createNode({
            run: (ctx) => fn(ctx.value as T),
            next: [mapped.node],
            meta: withInspectorMeta(undefined, {
              type: "event.map",
              internal: true,
            }),
          }),
        );

        return mapped;
      },

      filter(fn: (value: T) => boolean): Event<T> {
        const filtered = createEvent<T>(deriveName(node, "filter"));

        append(
          createNode({
            run: (ctx) => {
              if (!fn(ctx.value as T)) {
                ctx.stop();
              }

              return ctx.value;
            },
            next: [filtered.node],
            meta: withInspectorMeta(undefined, {
              type: "event.filter",
              internal: true,
            }),
          }),
        );

        return filtered;
      },

      filterMap<Next>(fn: (value: T) => Next | undefined): Event<Next> {
        const mapped = createEvent<Next>(deriveName(node, "filterMap"));

        append(
          createNode({
            run: (ctx) => {
              const value = fn(ctx.value as T);

              if (value === undefined) {
                ctx.stop();
              }

              return value;
            },
            next: [mapped.node],
            meta: withInspectorMeta(undefined, {
              type: "event.filterMap",
              internal: true,
            }),
          }),
        );

        return mapped;
      },
    },
  );

  return result as Event<T>;
}

function deriveName(source: Node, operation: string): string | undefined {
  const name = readInspectorNodeMeta(source).name;

  return name ? `${name}.${operation}` : undefined;
}

function normalizeDevtoolsOptions(
  devtools: string | EventDevtoolsOptions | undefined,
): EventDevtoolsOptions {
  return typeof devtools === "string" ? { name: devtools } : (devtools ?? {});
}

// Descriptions and server helpers carry no DOM mount implementations.
import { scoped, type Scope } from "@virentia/core";
import { node, getActiveScope, isTracking, unwrapMicroScope, trackNode, isModelDefinition, isModelInstance, type Node as ReactiveNode } from "@virentia/core/internal";
import type { AnyModel, InstanceOf, InstanceApi, ModelDefinition } from "@virentia/core/models";
import { createElement, mergeProps, ModelRowDescription } from "./descriptions";
import { componentMetadataOf } from "./component";
import { isReadable, readSource, type Parent } from "./native-runtime";
import type { Binding, Child, Component, ElementDescriptor, Readable } from "./types";


export const list = Symbol("virentia.ui.list");

export const provider = Symbol("virentia.ui.provider");

export const portal = Symbol("virentia.ui.portal");

export const foreign = Symbol("virentia.ui.foreign");


/** A foreign renderer owns everything inside its native host element. */
export interface ForeignRoot<Value> {
  update(value: Value): void;
  dispose(): void;
}


/** Internal bridge contract; the foreign renderer owns the host's entire contents. */
export interface ForeignProps<Value> {
  readonly kind?: string;
  readonly as?: string;
  readonly node: Value;
  /** Supplied by server entrypoints, never by the browser adapter. */
  readonly serverRender?: (node: Value, scope: Scope) => string | Promise<string>;
  /** Reject synchronous SSR before starting an asynchronous renderer. */
  readonly asyncServerRender?: boolean;
  readonly mount: (
    host: Element,
    node: Value,
    scope: Scope,
    options: { hydrate: boolean; hydrationScope?: Scope },
  ) => ForeignRoot<Value>;
}


/** Create an opaque host without making the foreign node a native UI child. */
export function foreignTree<Value>(props: ForeignProps<Value>): ElementDescriptor {
  return createElement(foreign, props);
}

export interface ForProps<T> {
  each:
    | AnyModel
    | Iterable<T>
    | { readonly items: readonly T[] }
    | Readable<readonly T[]>
    | (() => Iterable<T> | { readonly items: readonly T[] });
  /** Components receive a ready model, or reactive props sourced from a data row. */
  view?: Component<any> | ((item: Readable<T>, index: Readable<number>) => Child);
  /** Optional local row fragment; no component instance or keys are introduced. */
  children?: (item: () => T, index: () => number) => Child;
  fallback?: Child;
}

export interface ModelForProps<M extends AnyModel> extends Omit<ForProps<InstanceOf<M>>, "each"> {
  each: M;
}

export function forItems<T>(source: ForProps<T>["each"] | ModelDefinition, scope: Scope): T[] {
  const value = isReadable(source) ? source.value : readSource(source);
  const iterable = isModelDefinition(value)
    ? scoped(scope, () => value.instances)
    : typeof value === "object" && value !== null && "items" in value
      ? value.items
      : value;
  return Array.from(iterable as Iterable<T>);
}

export function forKey<T>(item: T): unknown {
  return isModelInstance(item) ? (item as InstanceApi).id : item;
}

export function listKeyPaths(): (key: unknown) => string {
  let next = 0;
  const objects = new WeakMap<object, number>();
  return (key) => {
    if (typeof key === "object" && key !== null) {
      let id = objects.get(key);
      if (id === undefined) {
        id = next++;
        objects.set(key, id);
      }
      return `row:ref:${id}`;
    }
    return `row:${encodeURIComponent(String(key))}`;
  };
}

export function For<M extends AnyModel>(props: ModelForProps<M>): ElementDescriptor;

export function For<T>(props: ForProps<T>): ElementDescriptor;

export function For(props: ForProps<unknown> | ModelForProps<AnyModel>): ElementDescriptor {
  return createElement(list, props);
}

export interface RowValues<T> {
  item: T;
  index: number;
  changed?: ReactiveNode;
  readers?: Set<Scope>;
  itemUnit?: Readable<T>;
  indexUnit?: Readable<number>;
}

export interface ValueRow<T> extends RowValues<T> {
  changed: ReactiveNode;
  readers: Set<Scope>;
  itemUnit: Readable<T>;
  indexUnit: Readable<number>;
}

/** Model-container rows already have units; only value/index consumers need these. */
export function rowValueUnits<T>(row: RowValues<T>): ValueRow<T> {
  if (row.itemUnit) return row as ValueRow<T>;
  const changed = (row.changed = node());
  const readers = (row.readers = new Set<Scope>());
  const read = () => {
    if (isTracking()) {
      const active = getActiveScope();
      if (active) readers.add(unwrapMicroScope(active));
      trackNode(changed);
    }
  };
  row.itemUnit = {
    node: changed,
    get value() {
      read();
      return row.item;
    },
  };
  row.indexUnit = {
    node: changed,
    get value() {
      read();
      return row.index;
    },
  };
  return row as ValueRow<T>;
}

export function rowView<T>(props: ForProps<T>, row: RowValues<T>): Child {
  if (props.view) {
    const metadata = componentMetadataOf(props.view as Component<any>);
    if (metadata) {
      if (isModelInstance(row.item))
        return new ModelRowDescription(props.view as Component<any>, { model: row.item });
      const units = rowValueUnits(row);
      const value = row.item;
      const source =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? Object.fromEntries(
              Object.keys(value).map((key) => [
                key,
                key === "id"
                  ? (value as Record<string, unknown>)[key]
                  : {
                      node: units.itemUnit.node,
                      get value() {
                        return (units.itemUnit.value as Record<string, unknown>)[key];
                      },
                    },
              ]),
            )
          : { item: units.itemUnit };
      return createElement(props.view as Component<any>, source);
    }
    const units = rowValueUnits(row);
    return (props.view as (item: Readable<T>, index: Readable<number>) => Child)(
      units.itemUnit,
      units.indexUnit,
    );
  }
  if (props.children) {
    const units = rowValueUnits(row);
    return props.children(
      () => units.itemUnit.value,
      () => units.indexUnit.value,
    );
  }
  throw new TypeError("[ui] For requires view");
}


export function forRowView<T>(props: ForProps<T>, item: T, index: number): Child {
  return rowView(props, {
    item,
    index,
    itemUnit: { node: {}, value: item },
    indexUnit: { node: {}, value: index },
  });
}


export interface Context<T> {
  readonly id: symbol;
  readonly defaultValue: T;
  readonly Provider: Component<{ value: Binding<T>; children?: Child }>;
}

export function createContext<T>(defaultValue: T): Context<T> {
  const id = Symbol("virentia.ui.context");
  return {
    id,
    defaultValue,
    Provider: (props) => createElement(provider, mergeProps(props, { id })),
  };
}

export function Portal(props: { mount: Parent; children?: Child }): ElementDescriptor {
  return createElement(portal, props);
}

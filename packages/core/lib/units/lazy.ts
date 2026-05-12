import { createNode } from "../kernel";
import type { Node } from "../kernel";
import { withInspectorMeta } from "../kernel/inspector";
import { scoped } from "../scope";
import { requireActiveScope } from "../scope/internal";
import type { StoreSubscriber } from "./store";

const lazyUnitInternal = Symbol("virentia.lazyUnitInternal");

type AnyFunction = (this: unknown, ...args: any[]) => unknown;
type LazyLoader<T> = () => T | PromiseLike<T>;

interface LazyResolver<T> {
  hasValue(): boolean;
  load(): Promise<T>;
  prime(value: T): void;
  value(): T;
  watch(fn: (value: T) => void): void;
}

interface LazyUnitInternal<T> {
  prime(value: T): void;
}

interface MirroredNextList {
  next: Node[];
  mirror(target: Node): void;
}

export function lazyModel<Model extends object>(loader: LazyLoader<Model>): Model {
  const resolver = createLazyResolver(loader);
  const units = new Map<PropertyKey, unknown>();

  return new Proxy(Object.create(null) as Model, {
    get(target, property, receiver) {
      if (property === "then") {
        return undefined;
      }

      if (property === Symbol.toStringTag) {
        return "LazyModel";
      }

      if (property in target) {
        return Reflect.get(target, property, receiver);
      }

      if (typeof property === "symbol") {
        return undefined;
      }

      if (resolver.hasValue()) {
        const model = resolver.value();

        if (property in model && !units.has(property)) {
          return Reflect.get(model, property, model);
        }
      }

      let unit = units.get(property);

      if (!unit) {
        unit = createLazyUnit(() =>
          resolver.load().then((model) => Reflect.get(model, property, model)),
        );
        units.set(property, unit);

        resolver.watch((model) => {
          primeLazyUnit(unit, Reflect.get(model, property, model));
        });
      }

      return unit;
    },

    has(target, property) {
      if (property in target) return true;

      return resolver.hasValue() && property in resolver.value();
    },

    ownKeys(target) {
      if (resolver.hasValue()) {
        return Reflect.ownKeys(resolver.value());
      }

      return Reflect.ownKeys(target);
    },

    getOwnPropertyDescriptor(target, property) {
      if (property in target) {
        return Reflect.getOwnPropertyDescriptor(target, property);
      }

      if (resolver.hasValue() && property in resolver.value()) {
        return {
          configurable: true,
          enumerable: true,
        };
      }

      return undefined;
    },
  });
}

function createLazyUnit<T>(loader: LazyLoader<T>): T {
  const resolver = createLazyResolver(loader);
  const mirroredNext = createMirroredNextList();
  const children = new Map<PropertyKey, unknown>();
  const derived = new Set<(unit: T) => void>();
  const node = createNode({
    meta: withInspectorMeta(undefined, {
      type: "lazy",
      callable: true,
    }),
    run: async (ctx) => {
      const unit = await resolveUnit();

      ctx.stop();
      ctx.launch(unit.node, ctx.value);

      return ctx.value;
    },
  });
  const target = (...args: unknown[]) => {
    const scope = requireActiveScope();

    return resolver.load().then((unit) => {
      primeUnit(unit);

      if (typeof unit !== "function") {
        throw new Error("Lazy unit is not callable");
      }

      return scoped(scope, () => (unit as AnyFunction)(...args));
    });
  };

  node.next = mirroredNext.next;

  Object.defineProperty(target, "node", {
    configurable: true,
    enumerable: true,
    value: node,
  });

  const internal: LazyUnitInternal<T> = {
    prime(value) {
      if (resolver.hasValue()) {
        return;
      }

      resolver.prime(value);
      primeUnit(value);
    },
  };

  return new Proxy(target, {
    get(target, property, receiver) {
      if (property === lazyUnitInternal) {
        return internal;
      }

      if (property === "then") {
        return undefined;
      }

      if (property === Symbol.toStringTag) {
        return "LazyUnit";
      }

      if (property === "node") {
        return node;
      }

      if (resolver.hasValue()) {
        return Reflect.get(resolver.value() as object, property, resolver.value() as object);
      }

      if (property === "map" || property === "filter" || property === "filterMap") {
        return (...args: unknown[]) => createDerivedLazyUnit(property, args);
      }

      if (property === "subscribe") {
        return (fn: StoreSubscriber<unknown>) => subscribeLazyStore(fn);
      }

      if (nestedUnitKeys.has(property)) {
        return getChildLazyUnit(property);
      }

      if (property === "value") {
        throw new Error("Lazy unit is not loaded yet");
      }

      if (property in target) {
        return Reflect.get(target, property, receiver);
      }

      return undefined;
    },

    set(_target, property, value) {
      if (!resolver.hasValue()) {
        throw new Error("Lazy unit is not loaded yet");
      }

      return Reflect.set(resolver.value() as object, property, value, resolver.value() as object);
    },

    has(target, property) {
      return (
        property === "node" ||
        property in target ||
        (resolver.hasValue() && property in (resolver.value() as object))
      );
    },

    ownKeys(target) {
      if (resolver.hasValue()) {
        return Reflect.ownKeys(resolver.value() as object);
      }

      return Reflect.ownKeys(target);
    },

    getOwnPropertyDescriptor(target, property) {
      if (property in target) {
        return Reflect.getOwnPropertyDescriptor(target, property);
      }

      if (resolver.hasValue() && property in (resolver.value() as object)) {
        return {
          configurable: true,
          enumerable: true,
        };
      }

      return undefined;
    },
  }) as T;

  async function resolveUnit(): Promise<{ node: Node }> {
    const unit = await resolver.load();

    primeUnit(unit);

    if (!isUnit(unit)) {
      throw new Error("Lazy model property is not a Virentia unit");
    }

    return unit;
  }

  function primeUnit(unit: T): void {
    if (!isUnit(unit)) {
      return;
    }

    mirroredNext.mirror(unit.node);
    primeChildren(unit);
    primeDerived(unit);
  }

  function getChildLazyUnit(property: PropertyKey): unknown {
    let child = children.get(property);

    if (!child) {
      child = createLazyUnit(() =>
        resolver.load().then((unit) => Reflect.get(unit as object, property, unit as object)),
      );
      children.set(property, child);

      resolver.watch((unit) => {
        primeLazyUnit(child, Reflect.get(unit as object, property, unit as object));
      });
    }

    return child;
  }

  function createDerivedLazyUnit(property: PropertyKey, args: unknown[]): unknown {
    let primed = false;
    const child = createLazyUnit(() => {
      return resolver.load().then((unit) => {
        const method = Reflect.get(unit as object, property, unit as object);

        if (typeof method !== "function") {
          throw new Error("Lazy unit member is not callable");
        }

        return method.apply(unit, args);
      });
    });

    derived.add((unit) => {
      if (primed) {
        return;
      }

      const method = Reflect.get(unit as object, property, unit as object);

      if (typeof method === "function") {
        primeLazyUnit(child, method.apply(unit, args));
        primed = true;
      }
    });

    if (resolver.hasValue()) {
      primeDerived(resolver.value());
    }

    return child;
  }

  function primeChildren(unit: T): void {
    for (const [property, child] of children) {
      primeLazyUnit(child, Reflect.get(unit as object, property, unit as object));
    }
  }

  function primeDerived(unit: T): void {
    for (const prime of derived) {
      prime(unit);
    }
  }

  function subscribeLazyStore(fn: StoreSubscriber<unknown>): () => void {
    let active = true;
    let unsubscribe: (() => void) | null = null;

    void resolver.load().then((unit) => {
      if (!active) return;

      primeUnit(unit);

      if (!isSubscribable(unit)) {
        throw new Error("Lazy unit is not subscribable");
      }

      unsubscribe = unit.subscribe(fn);
    });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }
}

function createLazyResolver<T>(loader: LazyLoader<T>): LazyResolver<T> {
  const watchers = new Set<(value: T) => void>();
  let loaded = false;
  let value: T;
  let promise: Promise<T> | null = null;
  const primeValue = (next: T): void => {
    if (loaded) {
      return;
    }

    loaded = true;
    value = next;

    for (const watcher of watchers) {
      watcher(next);
    }
  };

  return {
    hasValue() {
      return loaded;
    },

    load() {
      if (loaded) {
        return Promise.resolve(value);
      }

      if (!promise) {
        promise = Promise.resolve()
          .then(loader)
          .then((result) => {
            primeValue(result);

            return result;
          });
      }

      return promise;
    },

    prime(next) {
      primeValue(next);
    },

    value() {
      if (!loaded) {
        throw new Error("Lazy value is not loaded yet");
      }

      return value;
    },

    watch(fn) {
      if (loaded) {
        fn(value);
        return;
      }

      watchers.add(fn);
    },
  };
}

function createMirroredNextList(): MirroredNextList {
  const next: Node[] = [];
  const targets = new Set<Node>();
  const nativePush = next.push.bind(next);
  const nativeSplice = next.splice.bind(next);

  Object.defineProperty(next, "push", {
    configurable: true,
    value(...items: Node[]) {
      const length = nativePush(...items);

      for (const target of targets) {
        for (const item of items) {
          appendNext(target, item);
        }
      }

      return length;
    },
  });

  Object.defineProperty(next, "splice", {
    configurable: true,
    value(start: number, deleteCount?: number, ...items: Node[]) {
      const removed =
        deleteCount === undefined
          ? nativeSplice(start)
          : nativeSplice(start, deleteCount, ...items);

      for (const target of targets) {
        for (const item of removed) {
          detachNext(target, item);
        }

        for (const item of items) {
          appendNext(target, item);
        }
      }

      return removed;
    },
  });

  return {
    next,

    mirror(target) {
      if (targets.has(target)) {
        return;
      }

      targets.add(target);

      for (const item of next) {
        appendNext(target, item);
      }
    },
  };
}

function primeLazyUnit(value: unknown, unit: unknown): void {
  const internal = isObject(value)
    ? (Reflect.get(value, lazyUnitInternal) as LazyUnitInternal<unknown> | undefined)
    : undefined;

  internal?.prime(unit);
}

function appendNext(target: Node, next: Node): void {
  target.next = target.next ?? [];

  if (!target.next.includes(next)) {
    target.next.push(next);
  }
}

function detachNext(target: Node, next: Node): void {
  if (!target.next) return;

  const index = target.next.indexOf(next);

  if (index >= 0) {
    target.next.splice(index, 1);
  }
}

function isUnit(value: unknown): value is { node: Node } {
  return isObject(value) && "node" in value;
}

function isSubscribable(
  value: unknown,
): value is { subscribe(fn: StoreSubscriber<unknown>): () => void } {
  return isObject(value) && typeof Reflect.get(value, "subscribe") === "function";
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

const nestedUnitKeys = new Set<PropertyKey>([
  "$inFlight",
  "$pending",
  "abort",
  "aborted",
  "done",
  "doneData",
  "fail",
  "failData",
  "failed",
  "finally",
  "settled",
  "started",
]);

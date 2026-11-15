import {
  modelDefinitionBindingOf,
  modelInstanceBindingOf,
  modelValueBinding,
  modelValueBindingOf,
  setModelValueBinding,
  type ModelBindingData,
  type ModelInstanceBinding,
  type ModelValueBinding,
  type ModelValueContext,
} from "./bindings";
import { boundScopeKey } from "../units/event";

interface ValueData extends ModelBindingData {
  readonly value: object;
  initialized: boolean;
}

/**
 * @internal A composite framework API returned by model.setup. The shared API
 * declares units once; each instance gets scoped handles, never another graph.
 * Getter properties are evaluated in the containing instance, so child/ref
 * selectors can follow replacement without retaining the previous child.
 */
export function scopedModelValue<T extends object>(
  value: T,
  options?: { bound?(value: T, context: ModelValueContext): void; initialize?(value: T, instance: ModelInstanceBinding): void },
): T {
  if (modelValueBindingOf(value)) return value;
  const binding = new NamespaceBinding(value, options?.initialize, options?.bound);
  Object.defineProperty(value, modelValueBinding, {
    configurable: true,
    value: binding,
  });
  setModelValueBinding(value, binding);
  return value;
}

class FixedValue implements ModelValueBinding {
  constructor(readonly value: object) {}
  bind(): object { return this.value; }
}

class NamespaceBinding<T extends object> implements ModelValueBinding {
  readonly key = Symbol("model.namespace");
  readonly initialize: ((context: ModelValueContext) => void) | undefined;
  constructor(readonly source: T, initialize?: (value: T, instance: ModelInstanceBinding) => void, readonly bound?: (value: T, context: ModelValueContext) => void) {
    if (initialize) this.initialize = context => {
      const data = this.data(context);
      if (data.initialized) return;
      initialize(data.value as T, context.instance);
      data.initialized = true;
    };
  }
  bind(context: ModelValueContext): object { return this.data(context).value; }
  private data(context: ModelValueContext): ValueData {
    const instance = context.instance;
    let data = instance.getData?.(this.key) as ValueData | undefined;
    if (!data) {
      const value = namespace(this.source, context, new WeakMap());
      data = { bindingKey: this.key, value, initialized: false };
      this.bound?.(value as T, context);
      if (!instance.setData) throw new Error("[models] Scoped namespaces require model binding data");
      instance.setData(data);
    }
    return data;
  }
}

function unit(value: object): boolean {
  return "node" in value && (typeof value === "function" || "subscribe" in value);
}

function namespace(source: object, context: ModelValueContext, seen: WeakMap<object, object>): object {
  const known = seen.get(source);
  if (known) return known;
  const native = unit(source) || typeof source === "function";
  const target = native ? context.native(source) : Object.create(Object.getPrototypeOf(source));
  const cache = new Map<PropertyKey, unknown>();
  // One scoped accessor per namespace, rather than a new closure on every get.
  const read = context.native((key: PropertyKey) => Reflect.get(source, key, source));
  const keys = context.native(() => Reflect.ownKeys(source));
  const describe = context.native((key: PropertyKey) => Reflect.getOwnPropertyDescriptor(source, key));
  const has = context.native((key: PropertyKey) => Reflect.has(source, key));
  let fixed!: FixedValue;
  const bind = context.native((value: unknown): unknown => {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;
    if (modelValueBindingOf(value)) return context.bind(value);
    if (modelInstanceBindingOf(value) || modelDefinitionBindingOf(value)) return value;
    if (unit(value) || typeof value === "function") return context.bind(value);
    const proto = Reflect.getPrototypeOf(value);
    return proto === Object.prototype || proto === null ? namespace(value, context, seen) : value;
  });
  const view = new Proxy(target, {
    get(current, key, receiver) {
      if (key === modelValueBinding) return fixed;
      if (key === boundScopeKey) return Reflect.get(current, key, receiver);
      if (native && key === "abort" && "pending" in source) return Reflect.get(current, key, receiver);
      // Native identities and framework-private protocols remain opaque.
      if (key === "node" && native) return Reflect.get(source, key, source);
      if (typeof key === "symbol") {
        const value = Reflect.get(source, key, source);
        return value && (typeof value === "object" || typeof value === "function") && unit(value) ? bind(value) : value;
      }
      if (!native && Object.hasOwn(current, key)) return Reflect.get(current, key, receiver);
      if (cache.has(key)) return cache.get(key);
      const descriptor = describe(key);
      if (descriptor?.get) return bind(read(key));
      const value = bind(Reflect.get(source, key, source));
      cache.set(key, value);
      return value;
    },
    set(current, key, value) { return Reflect.defineProperty(current, key, { value, writable: true, configurable: true, enumerable: true }); },
    has(current, key) { return Reflect.has(current, key) || has(key); },
    ownKeys(current) { return [...new Set([...keys(), ...Reflect.ownKeys(current)])]; },
    getOwnPropertyDescriptor(current, key) {
      const own = Reflect.getOwnPropertyDescriptor(current, key);
      if (own) return own;
      const descriptor = describe(key);
      if (!descriptor) return;
      return { configurable: true, enumerable: descriptor.enumerable, get: () => Reflect.get(view, key) };
    },
  });
  fixed = new FixedValue(view);
  setModelValueBinding(view, fixed);
  seen.set(source, view);
  return view;
}

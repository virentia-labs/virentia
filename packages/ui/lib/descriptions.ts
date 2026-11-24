// Inert JSX descriptions. This module has no dependency on DOM mounting,
// lifecycle owners or the model factories. The renderer uses these same classes.
import { retainShapes } from "@virentia/core/internal";
import type { Child, Component, ElementDescriptor } from "./types";
type Props = Record<string, unknown>;
export const element = Symbol("virentia.ui.element");
export const Fragment = Symbol("virentia.ui.fragment");
export const childPropSources = new WeakMap<Props, Props>();

/**
 * Descriptions created by this runtime share one prototype marker: own keys stay
 * `type` and `props`, and mount recognizes them by class before any duck typing.
 */
export abstract class Description {
  declare readonly [element]: true;
}
Object.defineProperty(Description.prototype, element, { value: true });
export class ElementDescription extends Description implements ElementDescriptor {
  constructor(
    readonly type: ElementDescriptor["type"],
    readonly props: Props,
  ) {
    super();
  }
}

/** The automatic JSX runtime's unkeyed description: `createElement(type, props)`. */
export function describe(
  type: string | Component<any> | symbol,
  props: Record<string, unknown> | null,
): ElementDescriptor {
  return props == null ? new OwnedDescription(type, {}) : new ElementDescription(type, props);
}

/** JSX produces inert descriptions. Component code only runs during mounting. */
export function createElement<P extends object>(
  type: string | Component<P> | symbol,
  props?: P | null,
  ...children: Child[]
): ElementDescriptor;
export function createElement<P extends object>(
  type: string | Component<P> | symbol,
  props?: P | null,
  first: Child = undefined,
): ElementDescriptor {
  const count = arguments.length - 2;
  let content = first;
  // Most native leaves have one child; an argument array need only escape
  // when the description actually contains several children.
  if (count > 1) {
    // oxlint-disable-next-line unicorn/no-new-array -- Allocate the exact arity, then fill each slot.
    const children: Child[] = new Array(count);
    for (let index = 0; index < count; index++) children[index] = arguments[index + 2];
    content = children;
  }
  if (props == null) return new OwnedDescription(type, count > 0 ? { children: content } : {});
  if (typeof type === "string" && count > 0)
    return new NativeDescription(type, props as Props, content);
  let resolved = props as Props;
  if (count > 0) {
    {
      const source = resolved;
      resolved = new Proxy(new ChildProps(source, content), childPropsHandler) as unknown as Props;
      childPropSources.set(resolved, source);
    }
  }
  return new ElementDescription(type, resolved);
}
export const h = createElement;

/** JSX keys are metadata, not model inputs or DOM attributes. */
export function keyedElement<P extends object>(
  type: string | Component<P> | symbol,
  props: P | null,
  key: string | number | symbol,
): ElementDescriptor {
  if (typeof props === "function")
    return createElement(type, mergeProps(props as never, { key }) as P);
  return new KeyDescription(type, (props ?? {}) as Props, key);
}

export class KeyDescription extends Description implements ElementDescriptor {
  readonly type: ElementDescriptor["type"];
  /** An own property, like an ordinary description's, without an accessor per instance. */
  readonly props: Props;
  readonly #source: Props;
  readonly #props: Props;
  constructor(type: ElementDescriptor["type"], source: Props, key: string | number | symbol) {
    super();
    this.type = type;
    this.props = this.#props = new Proxy(
      new KeyProps(source, key),
      keyPropsHandler,
    ) as unknown as Props;
    this.#source = source;
  }
  /** The props to mount: the source, unless `props` was replaced, as on an ordinary description. */
  static source(description: KeyDescription): Props {
    const props = description.props;
    return props === description.#props ? description.#source : props;
  }
}

export function ownProp(props: Props, key: string): unknown {
  return Object.hasOwn(props, key) ? props[key] : undefined;
}

class KeyProps {
  readonly #source: Props;
  readonly #key: string | number | symbol;
  constructor(source: Props, key: string | number | symbol) {
    this.#source = source;
    this.#key = key;
  }
  static get(target: KeyProps, key: PropertyKey): unknown {
    if (key === "key") return target.#key;
    if (Object.hasOwn(target.#source, key)) return Reflect.get(target.#source, key);
  }
  static has(target: KeyProps, key: PropertyKey): boolean {
    return key === "key" || Object.hasOwn(target.#source, key);
  }
  static keys(target: KeyProps): (string | symbol)[] {
    const keys = Reflect.ownKeys(target.#source);
    if (!keys.includes("key")) keys.push("key");
    return keys;
  }
}
const keyPropsHandler: ProxyHandler<KeyProps> = {
  get: KeyProps.get,
  has: KeyProps.has,
  ownKeys: KeyProps.keys,
  getOwnPropertyDescriptor(target, key) {
    if (KeyProps.has(target, key)) return { enumerable: true, configurable: true };
  },
  getPrototypeOf(target) {
    const prototype = Reflect.getPrototypeOf(target);
    return prototype === KeyProps.prototype ? Object.prototype : prototype;
  },
  preventExtensions(target) {
    if (Reflect.getPrototypeOf(target) === KeyProps.prototype)
      Reflect.setPrototypeOf(target, Object.prototype);
    return Reflect.preventExtensions(target);
  },
};

/** A known ordinary props object needs neither a weak registration nor shape tracking. */
export class OwnedDescription extends Description implements ElementDescriptor {
  constructor(
    readonly type: ElementDescriptor["type"],
    readonly props: Props,
  ) {
    super();
  }
}

/** A list row of a model component: its props are exactly the runtime's `{ model }`. */
export class ModelRowDescription extends OwnedDescription {}

/** Native attributes and explicit children can travel separately until inspected. */
export class NativeDescription extends Description implements ElementDescriptor {
  readonly type: string;
  readonly #source: Props;
  readonly #children: Child;
  #props?: Props;
  constructor(type: string, source: Props, children: Child) {
    super();
    this.type = type;
    this.#source = source;
    this.#children = children;
    Object.defineProperty(this, "props", nativeDescriptionProps);
  }
  get props(): Props {
    if (!this.#props) {
      this.#props = new Proxy(
        new ChildProps(this.#source, this.#children),
        childPropsHandler,
      ) as unknown as Props;
      childPropSources.set(this.#props, this.#source);
    }
    return this.#props;
  }
  static source(description: NativeDescription): Props {
    return description.#source;
  }
  static children(description: NativeDescription): Child {
    return description.#children;
  }
}
const nativeDescriptionProps = {
  ...Object.getOwnPropertyDescriptor(NativeDescription.prototype, "props")!,
  enumerable: true,
};

// h(type, props, ...children) only overlays one key. Keep the original props
// live without the generic mergeProps source array and per-descriptor handlers.
export class ChildProps {
  readonly #source: Props;
  readonly #children: Child;
  constructor(source: Props, children: Child) {
    this.#source = source;
    this.#children = children;
  }
  static get(target: ChildProps, key: PropertyKey): unknown {
    if (key === "children") return target.#children;
    if (Object.hasOwn(target.#source, key)) return Reflect.get(target.#source, key);
  }
  static has(target: ChildProps, key: PropertyKey): boolean {
    return key === "children" || Object.hasOwn(target.#source, key);
  }
  static keys(target: ChildProps): (string | symbol)[] {
    const keys = Reflect.ownKeys(target.#source);
    if (!keys.includes("children")) keys.push("children");
    return keys;
  }
}
const childPropsHandler: ProxyHandler<ChildProps> = {
  get: ChildProps.get,
  has: ChildProps.has,
  ownKeys: ChildProps.keys,
  getOwnPropertyDescriptor(target, key) {
    if (ChildProps.has(target, key)) return { enumerable: true, configurable: true };
  },
  getPrototypeOf: () => Object.prototype,
};

/** Preserve getters and late spread values; JSX object spread would snapshot them. */
export function mergeProps(...sources: (Props | (() => Props | null | undefined))[]): Props {
  const read = (source: (typeof sources)[number]): Props =>
    (typeof source === "function" ? source() : source) ?? {};
  return new Proxy(
    {},
    {
      get(_target, key) {
        for (let i = sources.length - 1; i >= 0; i--) {
          const source = read(sources[i]);
          if (Object.prototype.hasOwnProperty.call(source, key)) return Reflect.get(source, key);
        }
      },
      has(_target, key) {
        return sources.some((source) => Object.prototype.hasOwnProperty.call(read(source), key));
      },
      ownKeys() {
        const keys = new Set<string | symbol>();
        for (const source of sources)
          for (const key of Reflect.ownKeys(read(source))) keys.add(key);
        return [...keys];
      },
      getOwnPropertyDescriptor(_target, key) {
        if (sources.some((source) => Object.prototype.hasOwnProperty.call(read(source), key))) {
          return { enumerable: true, configurable: true };
        }
      },
    },
  );
}

// Keep exactly the description shapes retained by the renderer before the split.
retainShapes(
  "ui/descriptions",
  new ElementDescription("", {}),
  new KeyDescription("", {}, ""),
  new OwnedDescription("", {}),
  new ModelRowDescription("", {}),
  new NativeDescription("", {}, null),
  new ChildProps({}, null),
);

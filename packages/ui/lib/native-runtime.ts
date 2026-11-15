import { foreignMount } from "./foreign-renderer";
import { list, provider, portal, foreign } from "./builtin-descriptions";
import { mountList, mountProvider, mountPortal } from "./builtin-mounts";
import type { Context, ForProps, ModelForProps, ForeignProps, ForeignRoot } from "./builtin-descriptions";
export { For, Portal, createContext, list, provider, portal, foreign, forItems, forKey, listKeyPaths, forRowView } from "./builtin-descriptions";
export type { Context, ForProps, ModelForProps, ForeignProps, ForeignRoot } from "./builtin-descriptions";
export { render as renderBase, hydrate as hydrateBase, attachComponentRoot as attachComponentRootBase };
import { Description, ElementDescription, KeyDescription, OwnedDescription, ModelRowDescription, NativeDescription, childPropSources, ownProp, element, Fragment, describe, createElement, keyedElement, h, mergeProps } from "./descriptions";
export { element, Fragment, describe, createElement, keyedElement, h, mergeProps } from "./descriptions";
import { scoped, getOwner, type Owner, type Scope, type EventCallable } from "@virentia/core";
import {
  afterBulkRemoval,
  fieldIsOneWay,
  isModelDefinition,
  isModelInstance,
  captureScopeSnapshot,
  modelInstanceBindingOf,
  modelDefinitionBindingOf,
  modelDefaultCreator,
  modelViewSnapshotOf,
  modelViewCaptureOf,
  modelDefaultViewSnapshotOf,
  resolveModelInstance,
  node,
  prepareOwnedNode,
  isInspectorEnabled,
  isInspectorDiscoverable,
  registerInspectorNode,
  prepareInspectorSnapshotNode,
  runScopeFrame,
  setActiveScope,
  runDetached,
  trackNode,
  unwrapMicroScope,
  setSidScopeFrame,
  setOwner,
  getActiveScope,
  isTracking,
  sequenceBindingOf,
  directModelMemberOf,
  type DirectModelMember,
  queuedSlot,
  retainShapes,
  fixedStoreNodeOf,
  collectScopedNodes,
  registerSynchronousMethodSink,
  reconcileScopedEdges,
  reconcileScopedSource,
  detachScopedDependent,
  type SequenceOperation,
  markStoreTransient,
  withUnitDeclarationTracker,
  setUnitDeclarationTracker,
  type Node as ReactiveNode,
  type ModelInstanceBinding,
  type ModelDisposalTrace,
  type ModelCollectionBinding,
  type ModelViewCapture,
} from "@virentia/core/internal";
import {
  type AnyModel,
  type InstanceOf,
  type InstanceApi,
  type ModelDefinition,
} from "@virentia/core/models";
import { componentMetadataOf, type ComponentMetadata } from "./component";
import {
  closeLifetimesClearing,
  disposeLifetime,
  lifetime,
  LifetimeOwner,
  lifetimeContains,
  ownCleanup,
  ownDOMNode,
  ownInnerNode,
  ownResource,
  cleanupResource,
  type Lifetime,
} from "./lifetime";
import type {
  Binding,
  Child,
  Component,
  ComponentSelf,
  ElementDescriptor,
  Readable,
} from "./types";
import type { LifecycleEvent } from "./ui";

export { lifetime } from "./lifetime";
export { action } from "./action";
export type { ComponentSelf } from "./types";

export type Parent = Element | DocumentFragment;
export type Props = Record<string, unknown>;
type Cleanup = () => void;
export type Detach = () => Promise<void>;
type MarkedElement = ElementDescriptor & { [element]: true };
type TreePath = string | ChildPath | ArrayChildPath;
/** No DOM/context references: retained models may keep their identity path. */
export class ChildPath {
  #value?: string;
  constructor(
    readonly parent: TreePath,
    readonly segment: string | number,
  ) {}
  toString(): string {
    return (this.#value ??= `${this.parent}.${this.segment}`);
  }
}
/** Array coordinates do not need an intermediate `item:index.0` string. */
class ArrayChildPath {
  #value?: string;
  constructor(
    readonly parent: TreePath,
    readonly index: number,
  ) {}
  toString(): string {
    return (this.#value ??= `${this.parent}.item:${this.index}.0`);
  }
}
interface MountTask {
  context: UIContext;
  callback: () => void | Cleanup;
  unregister: Cleanup;
  hydrateForeign: boolean;
  ref: boolean;
}
export interface RootState {
  collections?: Map<ModelDefinition, ModelCollectionBinding>;
  bindings?: Set<ReactiveNode>;
  inspectorRoot?: ReactiveNode;
  scopeFrame?: boolean;
  removeNode?: (node: Node) => void;
  /** Nodes whose removal waits for the end of a model collection's bulk removal. */
  removals?: Node[];
  depth: number;
  mounts: MountTask[];
  errors: unknown[];
  models: ComponentRecord[];
  scope: Scope;
  server: boolean;
  identifierPrefix: string;
  lifetime?: Owner;
  serverSucceeded?: boolean;
  hydration?: HydrationState;
}
export interface UIContext {
  scope: Scope;
  /** Structural ranges close before invalidated descendant DOM reads. */
  depth: number;
  /** Restore controlled ancestors after an owned subtree changes. */
  afterDOM?: () => void;
  owner: Lifetime;
  document?: Document;
  namespace: string;
  values: ReadonlyMap<symbol, () => unknown>;
  root: RootState;
  path: TreePath;
  nextChild: number;
  /** Old branch owner during an atomic dynamic replacement. */
  replacing?: Owner;
  /** The current component remains available in views, DOM handlers and owned actions. */
  component?: ComponentSelf<any>;
  /**
   * The element created in this frame's lifetime that receives its children.
   * Nodes placed into it leave together with it (see ownInnerNode).
   */
  ownedParent?: Parent;
}

interface PropSlot {
  readonly changed: ReactiveNode;
  readonly retarget: ReactiveNode;
  value: unknown;
  readonly readers: Set<Scope>;
  readonly unit: Readable<unknown>;
}

const componentRecordKey = Symbol("virentia.ui.component.record");
interface ComponentRecord {
  readonly bindingKey: typeof componentRecordKey;
  readonly model: InstanceApi;
  readonly definition: ModelDefinition;
  owner?: Lifetime;
  slots?: Map<string, PropSlot>;
  proxy: Props;
  inputs?: Set<string>;
  props: Props;
  /**
   * Set a prop before the view props exist, without taking them: false once
   * they do. Nothing can observe such a prop yet, other than through `props`.
   */
  defer?(key: string, value: unknown): boolean;
  committed: boolean;
  attachment?: UIContext;
  context?: UIContext;
  readonly root: RootState;
  readonly path: TreePath;
  readonly depth: number;
  readonly namespace: string;
}
const componentRecords = new WeakMap<object, ComponentRecord>();
function componentRecordOf(
  model: object,
  binding = modelInstanceBindingOf(model),
): ComponentRecord | undefined {
  return binding?.getData
    ? (binding.getData(componentRecordKey) as ComponentRecord | undefined)
    : componentRecords.get(model);
}
const typeNames = new WeakMap<ModelDefinition, string>();
const modelFieldKeys = new WeakMap<ModelDefinition, ReadonlySet<string>>();
const emptyContextValues: ReadonlyMap<symbol, () => unknown> = new Map();
let nextTypeName = 0;
let activeContext: UIContext | undefined;
let uiFrameDepth = 0;
const uiReadBoundary = {
  get depth() {
    return uiFrameDepth;
  },
};
const automaticDisposalTrace: ModelDisposalTrace = {};

function disposeOwnedModel(
  model: InstanceApi,
  binding: ModelInstanceBinding,
): void | Promise<void> {
  return binding.disposeWithTrace
    ? binding.disposeWithTrace(automaticDisposalTrace)
    : model.dispose();
}
interface HydrationState {
  active: boolean;
  failed: boolean;
  cursors: Map<Parent, Node | null>;
}
export const htmlNamespace = "http://www.w3.org/1999/xhtml";
export const svgNamespace = "http://www.w3.org/2000/svg";
export const mathNamespace = "http://www.w3.org/1998/Math/MathML";

// ---------------------------------------------------------------------------
// Compiled templates. `@virentia/ui/vite` turns a JSX subtree of native
// elements into a blueprint plus the values of its dynamic places ("holes").
// Mounting clones the static DOM, built once per document, and binds only the
// holes, with the frames, paths and depths the element-by-element path would
// have used. Everything else — reading `props`, hydration, the server — sees
// the description tree the JSX runtime would have produced.

/** A blueprint element as the compiler emits it. */
export type TemplateBlueprint = readonly [
  tag: string,
  attributes: readonly (readonly [name: string, kind: 0 | 1 | 2, payload: unknown])[] | 0,
  children:
    | readonly (string | number | readonly [0, unknown] | readonly [1, TemplateBlueprint])[]
    | 0,
];

/** Attribute kinds: set on the cloned DOM (0), set at mount (1), or a hole set at mount. */
const bakedAttribute = 0,
  holeAttribute = 2;
/** Child kinds: a node of the clone, nothing (null or a boolean), an element, a hole. */
const textChild = 0,
  emptyChild = 1,
  elementChild = 2,
  holeChild = 3;

interface TemplateAttribute {
  readonly name: string;
  readonly kind: number;
  /** The value, or the hole's index. */
  readonly payload: unknown;
}

interface TemplateChild {
  readonly kind: number;
  /** The JSX value of a text or empty child; the hole's index. */
  readonly value: unknown;
  readonly node?: TemplateElement;
  /** A hole among several children: the frame of its array position. */
  readonly frame?: TemplateFrame;
}

/**
 * A frame the element-by-element path would create inside a template,
 * relative to the frame of the template's root element: the frame of a nested
 * element, or of a hole's position among several children. Bindings that
 * need nothing else of a frame name it by this instead of creating it.
 */
interface TemplateFrame {
  /** Depth past the root element frame's depth. */
  readonly depth: number;
  /** What its path adds to the root element frame's path. */
  readonly suffix: string;
}
const rootTemplateFrame: TemplateFrame = { depth: 0, suffix: "" };

/** Hands out element ordinals while a template is built. */
interface TemplateCounter {
  elements: number;
}

class TemplateElement {
  readonly tag: string;
  readonly attributes: readonly TemplateAttribute[];
  /** Applied to the cloned DOM: the class group and attributes set before any other prop. */
  readonly baked: readonly TemplateAttribute[];
  readonly bakedClasses?: Props;
  /** Set at mount through the element-by-element path, in source order. */
  readonly mounted: readonly TemplateAttribute[];
  readonly mountedKeys: readonly string[];
  /**
   * Whether every mounted attribute can be set or bound on its own, as the
   * generic path would for it: no ref or style, and a lone class key.
   */
  readonly directAttributes: boolean;
  readonly children: readonly TemplateChild[];
  /** This element or a descendant has something to set or mount. */
  readonly live: boolean;
  /** The element's own frame. */
  readonly frame: TemplateFrame;
  readonly parent?: TemplateElement;
  /** Its position among several children of its parent; undefined for an only child. */
  readonly index?: number;
  /** Its number in the template, in document order. */
  readonly ordinal: number;
  constructor(
    blueprint: TemplateBlueprint,
    holes: number[],
    counter: TemplateCounter = { elements: 0 },
    parent?: TemplateElement,
    index?: number,
  ) {
    const [tag, attributes, children] = blueprint;
    this.tag = tag;
    this.parent = parent;
    this.index = index;
    this.ordinal = counter.elements++;
    // As `fillTemplateElement` creates them: an only child's frame extends its
    // parent's path by the parent's first child index, an array position's
    // by its array coordinate (and one more level for the element itself).
    this.frame = !parent
      ? rootTemplateFrame
      : index === undefined
        ? { depth: parent.frame.depth + 1, suffix: `${parent.frame.suffix}.0` }
        : { depth: parent.frame.depth + 2, suffix: `${parent.frame.suffix}.item:${index}.0` };
    const all: TemplateAttribute[] = [];
    const baked: TemplateAttribute[] = [];
    const mounted: TemplateAttribute[] = [];
    let bakedClasses: Props | undefined;
    for (const [name, kind, payload] of attributes || []) {
      const attribute: TemplateAttribute = { name, kind, payload };
      all.push(attribute);
      if (kind !== bakedAttribute) mounted.push(attribute);
      else if (isClassProperty(name)) {
        // The class group is baked as one, where its first key stands.
        if (!bakedClasses) baked.push(attribute);
        (bakedClasses ??= {})[name] = payload;
      } else baked.push(attribute);
    }
    const nodes: TemplateChild[] = [];
    let live = mounted.length > 0;
    const list = children || [];
    const several = list.length > 1;
    for (let position = 0; position < list.length; position++) {
      const child = list[position];
      if (typeof child === "number") {
        holes.push(child);
        nodes.push({
          kind: holeChild,
          value: child,
          // `mountArrayEntry` mounts it in a frame of its own.
          frame: several
            ? { depth: this.frame.depth + 1, suffix: `${this.frame.suffix}.item:${position}` }
            : undefined,
        });
        live = true;
      } else if (typeof child === "string") nodes.push({ kind: textChild, value: child });
      else if (child[0] === 0) {
        const value = child[1];
        nodes.push({
          kind:
            typeof value === "string" || typeof value === "number" || typeof value === "bigint"
              ? textChild
              : emptyChild,
          value,
        });
      } else {
        const node = new TemplateElement(
          child[1],
          holes,
          counter,
          this,
          several ? position : undefined,
        );
        nodes.push({ kind: elementChild, value: undefined, node });
        live ||= node.live;
      }
    }
    this.attributes = all;
    this.baked = baked;
    this.bakedClasses = bakedClasses;
    this.mounted = mounted;
    this.mountedKeys = mounted.map((attribute) => attribute.name);
    let classKeys = 0;
    let direct = true;
    for (const { name } of mounted) {
      if (name === "ref" || name === "style" || name === "classList") direct = false;
      else if (isClassProperty(name)) classKeys++;
    }
    this.directAttributes = direct && classKeys <= 1 && mounted.length <= 30;
    this.children = nodes;
    this.live = live;
  }
}

export class Template {
  readonly root: TemplateElement;
  /** Indices of the holes that are children, for checks that walk a tree's components. */
  readonly childHoles: readonly number[];
  /** The document the last prototype was cloned into, and its namespace. */
  #document?: Document;
  #namespace?: string;
  #prototype?: Element;
  #others?: WeakMap<Document, Map<string, Element>>;
  constructor(blueprint: TemplateBlueprint) {
    const holes: number[] = [];
    this.root = new TemplateElement(blueprint, holes);
    this.childHoles = holes;
  }
  static clone(template: Template, document: Document, namespace: string): Element {
    let prototype: Element | undefined;
    if (template.#document === document && template.#namespace === namespace)
      prototype = template.#prototype;
    else if (!template.#document) {
      prototype = template.#prototype = buildTemplateElement(
        template.root,
        prototypeDocument(document),
        namespace,
      );
      template.#document = document;
      template.#namespace = namespace;
    } else {
      const byNamespace = (template.#others ??= new WeakMap()).get(document) ?? new Map();
      template.#others.set(document, byNamespace);
      prototype = byNamespace.get(namespace);
      if (!prototype)
        byNamespace.set(
          namespace,
          (prototype = buildTemplateElement(template.root, prototypeDocument(document), namespace)),
        );
    }
    // A clone stays in the prototype's document until it is inserted, right
    // away, into the page: cloning there and adopting the clone costs less
    // than importing it. Its images then load from its insertion, which a
    // mount reaches in the same synchronous step.
    return prototype!.cloneNode(true) as Element;
  }
}

const prototypeDocuments = new WeakMap<Document, Document>();

/**
 * Where the prototypes for a document are built: a document without a
 * browsing context, in which an element loads, fetches and runs nothing. A
 * document that cannot make one (not HTML, or no such DOM API) builds them
 * itself.
 */
function prototypeDocument(document: Document): Document {
  let inert = prototypeDocuments.get(document);
  if (!inert) {
    inert = document;
    if (document.contentType === "text/html" && typeof document.importNode === "function")
      try {
        inert = document.implementation.createHTMLDocument("");
      } catch {
        // Keep the document itself.
      }
    prototypeDocuments.set(document, inert);
  }
  return inert;
}

/** The static DOM of a template element: what the element-by-element path would set first. */
function buildTemplateElement(
  node: TemplateElement,
  document: Document,
  namespace: string,
): Element {
  const tag = node.tag;
  const own = tag === "svg" ? svgNamespace : tag === "math" ? mathNamespace : namespace;
  const dom =
    own === htmlNamespace ? document.createElement(tag) : document.createElementNS(own, tag);
  for (const { name, payload } of node.baked) {
    if (isClassProperty(name)) patchClasses(dom, readClasses(node.bakedClasses!));
    else if (name === "style") patchStyle(dom, payload, undefined);
    else patchProperty(dom, name, payload);
  }
  const childNamespace = tag === "foreignObject" ? htmlNamespace : own;
  for (const child of node.children) {
    if (child.kind === textChild) dom.appendChild(document.createTextNode(String(child.value)));
    else if (child.kind === elementChild)
      dom.appendChild(buildTemplateElement(child.node!, document, childNamespace));
  }
  return dom;
}

/** The props the JSX runtime would have given this element. */
function templateProps(node: TemplateElement, values: readonly unknown[]): Props {
  const props: Props = {};
  for (const { name, kind, payload } of node.attributes)
    props[name] = kind === holeAttribute ? memberValue(values[payload as number]) : payload;
  const children = node.children;
  if (children.length === 1) props.children = templateChildValue(children[0], values);
  else if (children.length > 1)
    props.children = children.map((child) => templateChildValue(child, values));
  return props;
}
function templateChildValue(child: TemplateChild, values: readonly unknown[]): unknown {
  if (child.kind === holeChild) return memberValue(values[child.value as number]);
  if (child.kind === elementChild)
    return new ElementDescription(child.node!.tag, templateProps(child.node!, values));
  return child.value;
}
/** A hole's value as the JSX runtime would have had it: a deferred member is read now. */
function memberValue(value: unknown): unknown {
  return value instanceof DeferredMember ? DeferredMember.facade(value) : value;
}

/**
 * A hole written `self.model.<name>` whose member binds directly when the
 * template is filled (see `jsxMember`): until then it stands for that member.
 */
class DeferredMember {
  // Declared, then assigned: a token per hole costs no more than a literal.
  declare self: ViewSelf;
  /** The model's binding: the instance the member reads. */
  declare instance: object;
  declare member: DirectModelMember;
  constructor(self: ViewSelf, instance: object, member: DirectModelMember) {
    this.self = self;
    this.instance = instance;
    this.member = member;
  }
  /** `self.model[name]`: what the hole would have held. */
  static facade(deferred: DeferredMember): unknown {
    return (deferred.self.model as unknown as Record<string, unknown>)[deferred.member.name];
  }
}

const noTemplateValues: readonly unknown[] = Object.freeze([]);
const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

/**
 * A compiled element's `props`: the object the JSX runtime would have given
 * it, built when anything first touches it (through `templatePropsHandler`).
 * From then on the props are the source of truth.
 *
 * The built props are an ordinary object beside this target, which keeps its
 * one hidden class. Only an operation whose Proxy invariant involves the target
 * (a non-configurable property, preventing extensions) moves them onto it.
 */
class TemplateProps {
  #description: TemplateDescription | undefined;
  #props: Props | undefined = undefined;
  constructor(description: TemplateDescription) {
    this.#description = description;
  }
  /** The props, built on first use: this target itself once they moved onto it. */
  static of(target: TemplateProps): Props {
    let props = target.#props;
    if (props === undefined) {
      props = target.#props = TemplateDescription.build(target.#description!);
      target.#description = undefined;
    }
    return props;
  }
  /** Move the props onto the target, which answers for them from then on. */
  static settle(target: TemplateProps): TemplateProps {
    const props = TemplateProps.of(target);
    if (props === (target as unknown as Props)) return target;
    Reflect.setPrototypeOf(target, Reflect.getPrototypeOf(props));
    for (const key of Reflect.ownKeys(props))
      Reflect.defineProperty(target, key, Reflect.getOwnPropertyDescriptor(props, key)!);
    if (!Reflect.isExtensible(props)) Reflect.preventExtensions(target);
    target.#props = target as unknown as Props;
    return target;
  }
  static built(target: TemplateProps): boolean {
    return target.#description === undefined;
  }
  /**
   * Node's inspector shows a Proxy's target, not what its traps answer, and
   * calls this on the Proxy itself: show a copy of the props.
   */
  [inspectCustom](
    _depth: number,
    options: object,
    inspect: (value: unknown, options: object) => string,
  ): string {
    return inspect(
      Object.create(Reflect.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this)),
      options,
    );
  }
}
// Every operation acts on the built props themselves, so the Proxy behaves as
// that ordinary object, invariants included. Accessors and inherited writes see
// the receiver, as they would on that object.
const templatePropsHandler: ProxyHandler<TemplateProps> = {
  get: (target, key, receiver) => Reflect.get(TemplateProps.of(target), key, receiver),
  set: (target, key, value, receiver) =>
    Reflect.set(TemplateProps.of(target), key, value, receiver),
  has: (target, key) => Reflect.has(TemplateProps.of(target), key),
  ownKeys: (target) => Reflect.ownKeys(TemplateProps.of(target)),
  getOwnPropertyDescriptor: (target, key) =>
    Reflect.getOwnPropertyDescriptor(TemplateProps.of(target), key),
  // A property that may end up non-configurable lives on the target.
  defineProperty: (target, key, descriptor) => {
    const props = TemplateProps.of(target);
    const configurable =
      descriptor.configurable ?? Reflect.getOwnPropertyDescriptor(props, key)?.configurable;
    return Reflect.defineProperty(
      configurable === true ? props : TemplateProps.settle(target),
      key,
      descriptor,
    );
  },
  deleteProperty: (target, key) => Reflect.deleteProperty(TemplateProps.of(target), key),
  getPrototypeOf: (target) => Reflect.getPrototypeOf(TemplateProps.of(target)),
  setPrototypeOf: (target, prototype) =>
    Reflect.setPrototypeOf(TemplateProps.of(target), prototype),
  isExtensible: (target) => Reflect.isExtensible(target),
  preventExtensions: (target) => Reflect.preventExtensions(TemplateProps.settle(target)),
};

/**
 * A compiled JSX element. Its `props` are built when first used, and an
 * element whose props were used or replaced mounts through them — edits
 * included, as an ordinary description would.
 */
class TemplateDescription extends Description implements ElementDescriptor {
  readonly type: string;
  /** An own property, like an ordinary description's, without an accessor per instance. */
  readonly props: Props;
  readonly #template: Template;
  readonly #values: readonly unknown[];
  readonly #target: TemplateProps;
  readonly #props: Props;
  constructor(template: Template, values: readonly unknown[]) {
    super();
    this.type = template.root.tag;
    const target = new TemplateProps(this);
    this.props = this.#props = new Proxy(target, templatePropsHandler) as unknown as Props;
    this.#template = template;
    this.#values = values;
    this.#target = target;
  }
  static build(description: TemplateDescription): Props {
    return templateProps(description.#template.root, description.#values);
  }
  static template(description: TemplateDescription): Template | undefined {
    // Once used or replaced, the props are the source of truth.
    return TemplateProps.built(description.#target) || description.props !== description.#props
      ? undefined
      : description.#template;
  }
  static values(description: TemplateDescription): readonly unknown[] {
    return description.#values;
  }
}

/** @internal Compiler output: one template per compiled JSX element, kept by its module. */
export function jsxTemplate(blueprint: TemplateBlueprint): Template {
  return new Template(blueprint);
}

/**
 * @internal Compiler output for a hole written `self.model.<name>`. When
 * `self` is a view's self and the member can bind directly, the hole stands
 * for the member until the template is filled, and the member's facade is
 * never created; otherwise it holds `self.model[name]`, read right here.
 */
export function jsxMember(self: unknown, name: string): unknown {
  if (self instanceof ViewSelf) {
    const instance = ViewSelf.binding(self);
    const member = directModelMemberOf(instance, name);
    if (member) {
      member.access(instance);
      return new DeferredMember(self, instance, member);
    }
  }
  return (self as { model: Record<string, unknown> }).model[name];
}

/** @internal Compiler output: the description of a compiled element with its hole values. */
export function jsxFromTemplate(
  template: Template,
  values?: readonly unknown[],
): ElementDescriptor {
  return new TemplateDescription(template, values ?? noTemplateValues);
}

function context(): UIContext {
  if (!activeContext) throw new Error("[ui] This API must run inside a mounted component");
  return activeContext;
}

/** @internal Identifier for legacy opaque renderer transports, not a UI self. */
export function contextualElementId(name: string): string {
  const ctx = context();
  return ctx.component?.elementId(name) ?? `${ctx.path}:${encodeURIComponent(name)}`;
}

export function runIn<T>(ctx: UIContext, callback: () => T): T {
  const previous = activeContext;
  const previousScope = setActiveScope(ctx.scope);
  const previousOwner = setOwner(ctx.owner ?? getOwner());
  const previousSid = setSidScopeFrame(ctx.path);
  activeContext = ctx;
  uiFrameDepth++;
  try {
    return callback();
  } finally {
    uiFrameDepth--;
    setSidScopeFrame(previousSid);
    setOwner(previousOwner);
    activeContext = previous;
    setActiveScope(previousScope);
  }
}

export function childContext(
  parent: UIContext,
  stableSegment?: string | number,
  own = true,
): UIContext {
  if (own) return new OwnedContext(parent, stableSegment);
  return {
    scope: parent.scope,
    depth: parent.depth + 1,
    afterDOM: parent.afterDOM,
    owner: parent.owner,
    document: parent.document,
    namespace: parent.namespace,
    values: parent.values,
    root: parent.root,
    path:
      typeof stableSegment === "number"
        ? new ArrayChildPath(parent.path, stableSegment)
        : new ChildPath(parent.path, stableSegment ?? parent.nextChild++),
    nextChild: 0,
    replacing: parent.replacing,
    component: parent.component,
    ownedParent: parent.ownedParent,
  };
}

/** Native property reads retain the full frame without allocating a reader callback. */
function readContextChildren(ctx: UIContext, props: Props): Child {
  const previous = activeContext;
  const previousScope = setActiveScope(ctx.scope);
  const previousOwner = setOwner(ctx.owner ?? getOwner());
  const previousSid = setSidScopeFrame(ctx.path);
  activeContext = ctx;
  uiFrameDepth++;
  try {
    return props.children as Child;
  } finally {
    uiFrameDepth--;
    setSidScopeFrame(previousSid);
    setOwner(previousOwner);
    activeContext = previous;
    setActiveScope(previousScope);
  }
}

function readContextValue(ctx: UIContext, source: Readable<Child>): Child {
  const previous = activeContext;
  const previousScope = setActiveScope(ctx.scope);
  const previousOwner = setOwner(ctx.owner ?? getOwner());
  const previousSid = setSidScopeFrame(ctx.path);
  activeContext = ctx;
  uiFrameDepth++;
  try {
    return source.value;
  } finally {
    uiFrameDepth--;
    setSidScopeFrame(previousSid);
    setOwner(previousOwner);
    activeContext = previous;
    setActiveScope(previousScope);
  }
}

/** A structural attachment's context and lifetime have exactly the same lifetime. */
class OwnedContext extends LifetimeOwner implements UIContext {
  scope: Scope;
  depth: number;
  afterDOM?: () => void;
  document?: Document;
  namespace: string;
  values: UIContext["values"];
  root: RootState;
  path: TreePath;
  nextChild = 0;
  replacing?: Owner;
  component?: ComponentSelf<any>;
  ownedParent: Parent | undefined = undefined;
  constructor(parent: UIContext, stableSegment?: string | number) {
    super(parent.owner);
    // Top-level nodes of this lifetime normally land in its parent frame's
    // element. When that element's lifetime closes in the same teardown, these
    // nodes leave together with it and need no separate DOM removal.
    const host = parent.ownedParent;
    const hostState = LifetimeOwner.stateOf(parent.owner);
    this.hostParent = host ?? hostState?.hostParent;
    this.hostOwner = host ? hostState : hostState?.hostOwner;
    this.scope = parent.scope;
    this.depth = parent.depth + 1;
    this.afterDOM = parent.afterDOM;
    this.document = parent.document;
    this.namespace = parent.namespace;
    this.values = parent.values;
    this.root = parent.root;
    this.path =
      typeof stableSegment === "number"
        ? new ArrayChildPath(parent.path, stableSegment)
        : new ChildPath(parent.path, stableSegment ?? parent.nextChild++);
    this.replacing = parent.replacing;
    this.component = parent.component;
  }
}

export function createRootContext(
  options: RenderOptions & { server?: boolean; document?: Document; namespace?: string },
): UIContext {
  if (!options?.scope) throw new TypeError("[ui] render/SSR requires an explicit scope");
  const scope = unwrapMicroScope(options.scope);
  return {
    depth: 0,
    scope,
    owner: lifetime(options.owner),
    document: options.document,
    namespace: options.namespace ?? htmlNamespace,
    values: emptyContextValues,
    ownedParent: undefined,
    // Every slot is declared, so a root keeps one hidden class all its life.
    root: {
      scope,
      depth: 0,
      mounts: [],
      errors: [],
      models: [],
      server: options.server ?? false,
      lifetime: options.owner,
      identifierPrefix: options.identifierPrefix ?? "root",
      collections: undefined,
      bindings: undefined,
      inspectorRoot: undefined,
      scopeFrame: undefined,
      removeNode: undefined,
      removals: undefined,
      serverSucceeded: undefined,
      hydration: undefined,
    },
    path: `ui:${encodeURIComponent(options.identifierPrefix ?? "root")}`,
    nextChild: 0,
  };
}

function disposeReplaced(ctx: UIContext | undefined): void {
  if (!ctx) return;
  try {
    ctx.owner.dispose();
  } catch (error) {
    // A committed replacement still receives its mount hooks if teardown fails.
    ctx.root.errors.push(error);
  }
}

function flushMounts(root: RootState): void {
  if (root.depth) return;
  // Most commits have nothing to run or settle; a list row's often does not.
  if (!root.mounts.length && !root.errors.length && !root.models.length) return;
  root.depth++;
  const errors = root.errors.splice(0);
  try {
    while (root.mounts.length) {
      const pending = root.mounts.splice(0);
      // Adopt every foreign SSR host before native mounted handlers can mutate
      // the shared scope or replace the just-hydrated children.
      pending.sort(
        (a, b) =>
          Number(b.hydrateForeign) - Number(a.hydrateForeign) || Number(b.ref) - Number(a.ref),
      );
      for (const { context: ctx, callback, unregister } of pending) {
        unregister();
        if (ctx.owner.closing) continue;
        try {
          const cleanup = runIn(ctx, callback);
          if (typeof cleanup === "function") ownCleanup(ctx.owner, () => runIn(ctx, cleanup));
        } catch (error) {
          try {
            ctx.owner.dispose();
          } catch {
            /* preserve the mount error */
          }
          errors.push(error);
        }
      }
    }
  } finally {
    root.depth--;
  }
  errors.push(...root.errors.splice(0));
  settleRetained(root, errors.length === 0);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "[ui] Mount callbacks failed");
}

/** Finalize model instances only after a complete client or server commit. */
export function settleRetained(root: RootState, succeeded: boolean): void {
  for (const record of root.models) {
    if (succeeded) record.committed = true;
    else if (record.model.alive) record.model.dispose();
  }
  root.models.length = 0;
}

export function mountWork<T>(ctx: UIContext, callback: () => T): T {
  ctx.root.depth++;
  let succeeded = false;
  try {
    const value = runIn(ctx, callback);
    if (ctx.afterDOM) runIn(ctx, ctx.afterDOM);
    succeeded = true;
    return value;
  } finally {
    ctx.root.depth--;
    if (succeeded) flushMounts(ctx.root);
  }
}

function domObserver<T extends ReactiveNode>(ctx: UIContext, input: T): T {
  const observer = prepareOwnedNode(input);
  if (isInspectorEnabled()) registerInspectorNode(observer);
  else if (isInspectorDiscoverable()) {
    const root = ctx.root;
    (root.bindings ??= new Set()).add(observer);
    if (!root.inspectorRoot) {
      root.inspectorRoot = node({
        meta: { "virentia.inspector": { internal: true, type: "ui.root" } },
      });
      prepareInspectorSnapshotNode(root.inspectorRoot, () => {
        for (const binding of root.bindings!) registerInspectorNode(binding);
        root.bindings!.clear();
      });
    }
  }
  return observer;
}

interface CapturedRead<T> {
  value: T;
  dependencies: ReadonlySet<ReactiveNode>;
}
function trackedRead<T>(ctx: UIContext, read: () => T): CapturedRead<T> {
  // Discover dependencies before allocating a graph consumer. Static attributes,
  // classes and prop shapes need one patch, not a permanent graph node. Use
  // synchronous frame only. Kernel/scoped/UI callback boundaries exclude
  // called units and nested DOM work from this read's dependency set.
  const previousContext = activeContext;
  const previousScope = setActiveScope(ctx.scope);
  const previousOwner = setOwner(ctx.owner ?? getOwner());
  const previousSid = setSidScopeFrame(ctx.path);
  activeContext = ctx;
  try {
    return collectScopedNodes(ctx.scope, read, uiReadBoundary);
  } finally {
    setSidScopeFrame(previousSid);
    setOwner(previousOwner);
    activeContext = previousContext;
    setActiveScope(previousScope);
  }
}

export function bind<T>(
  ctx: UIContext,
  read: () => T,
  patch: (value: T, reactive: boolean) => void,
  fixedSource?: ReactiveNode,
  captured?: CapturedRead<T>,
): void {
  const initial = fixedSource
    ? { value: runIn(ctx, read), dependencies: undefined }
    : (captured ?? trackedRead(ctx, read));
  if (!fixedSource && !initial.dependencies!.size) {
    initialPatch(ctx, () => patch(initial.value, false));
    return;
  }
  const observer = bindingObserver(ctx, read, patch, fixedSource);
  if (fixedSource) reconcileScopedSource(ctx.scope, observer, fixedSource);
  else reconcileScopedEdges(ctx.scope, observer, initial.dependencies!);
  // Initial errors must synchronously reach render() so it can roll back DOM.
  const value = initial.value;
  initialPatch(ctx, () => patch(value, true));
}

/** Shared by every DOM binding: inspector annotations replace a node's meta, never mutate it. */
const domBindingMeta = { "virentia.inspector": { type: "reaction", description: "DOM binding" } };

/**
 * The permanent consumer of a binding. A function of its own, so its closures
 * do not keep `bind`'s initial read and dependency set alive.
 */
function bindingObserver<T>(
  ctx: UIContext,
  read: () => T,
  patch: (value: T, reactive: boolean) => void,
  fixedSource: ReactiveNode | undefined,
): ReactiveNode {
  // DOM bindings are synchronous graph consumers, not async user reactions:
  // no declaration stack, AbortControllers or creation-time kernel drain.
  const observer: ReactiveNode = domObserver(ctx, {
    priority: 1 + ctx.depth,
    meta: domBindingMeta,
    [queuedSlot]: undefined,
    run() {
      if (ctx.owner.disposed) return;
      if (fixedSource) {
        mountWork(ctx, () => patch(read(), true));
        return;
      }
      const next = trackedRead(ctx, read);
      reconcileScopedEdges(ctx.scope, observer, next.dependencies);
      mountWork(ctx, () => patch(next.value, true));
    },
  });
  ownCleanup(ctx.owner, () => {
    ctx.root.bindings?.delete(observer);
    detachScopedDependent(ctx.scope, observer);
  });
  return observer;
}

function initialPatch(ctx: UIContext, patch: () => void): void {
  // An enclosing mount already defers commit callbacks. Re-enter the correct
  // UI frame, but do not add another depth/commit barrier for each attribute.
  if (ctx.root.depth && !ctx.afterDOM) runIn(ctx, patch);
  else mountWork(ctx, patch);
}

export interface RenderOptions {
  scope: Scope;
  /** Optional application/test lifetime, also owns retained component models. */
  owner?: Owner;
  /** Use the same unique prefix for each server/client root pair. */
  identifierPrefix?: string;
}

const invalidForeignHosts = new Set([
  "html",
  "head",
  "body",
  "template",
  "noscript",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "xmp",
  "listing",
  "svg",
  "math",
  "select",
  "option",
  "optgroup",
]);

/** Host tags must parse as ordinary non-void HTML elements on both sides. */
export function foreignHostTag(value: unknown, namespace: string): string {
  const tag = value ?? "div";
  if (
    namespace !== htmlNamespace ||
    typeof tag !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(tag) ||
    invalidForeignHosts.has(tag) ||
    voidElements.has(tag) ||
    rawTextElements.has(tag)
  ) {
    throw new Error("[ui] Foreign tree requires a non-void HTML host tag");
  }
  return tag;
}

/** Mount an independently disposable root. Existing container children are preserved. */
function render(factory: () => Child, container: Parent, options: RenderOptions): Detach {
  return mountRoot(factory, container, options, false);
}

/** Attach bindings to renderToString output without replacing its DOM nodes. */
function hydrate(factory: () => Child, container: Parent, options: RenderOptions): Detach {
  return mountRoot(factory, container, options, true);
}

/** @internal Attach a native component to its real, externally positioned root. */
function attachComponentRoot<P extends object>(
  type: Component<P>,
  props: P,
  host: Element,
  options: RenderOptions,
): Detach {
  if (host.hasChildNodes()) {
    throw new Error("[ui/embedded] The host root must be empty and exclusively owned by Virentia");
  }
  const ctx = createRootContext({
    ...options,
    document: host.ownerDocument,
    namespace: host.namespaceURI ?? htmlNamespace,
  });
  try {
    mountWork(ctx, () => {
      const child = childContext(ctx);
      runIn(child, () => {
        const view = componentView(type, props as Props, child);
        let channel: ReturnType<typeof propsChannel> | undefined;
        const attach = (next: Child) => {
          if (!isElement(next) || typeof next.type !== "string" || next.type !== host.localName) {
            throw new TypeError(
              `[ui/embedded] Component must return its declared, stable <${host.localName}> root; fragments and dynamic roots are unsupported`,
            );
          }
          if (channel) channel.update(next.props);
          else {
            channel = propsChannel(next.props, child);
            mountElement(next.type, channel.props, host, null, child, host);
          }
        };
        if (typeof view === "function") bind(child, view, attach);
        else attach(view);
      });
    });
  } catch (error) {
    try {
      ctx.owner.dispose();
    } catch {
      /* preserve the attachment error */
    }
    ctx.root.mounts.length = 0;
    ctx.root.errors.length = 0;
    throw error;
  }
  return () =>
    runIn(ctx, () => ctx.owner.dispose()).finally(() => {
      ctx.root.mounts.length = 0;
      ctx.root.errors.length = 0;
    });
}

function mountRoot(
  factory: () => Child,
  container: Parent,
  options: RenderOptions,
  hydrating: boolean,
): Detach {
  const document = container.ownerDocument;
  if (!document) throw new Error("[ui] render requires a DOM container");
  const ctx = createRootContext({
    ...options,
    document,
    namespace:
      container.nodeType === 1
        ? ((container as Element).namespaceURI ?? htmlNamespace)
        : htmlNamespace,
  });
  if (hydrating) {
    ctx.root.hydration = { active: true, failed: false, cursors: new Map() };
    ctx.root.depth++;
  }
  try {
    mountWork(ctx, () => {
      scoped(ctx.root.scope, () => {
        ctx.root.scopeFrame = true;
        try {
          const value = factory();
          preflight(value, ctx);
          const parent = hydrating ? container : document.createDocumentFragment();
          mount(value, parent, null, ctx);
          if (parent !== container) container.appendChild(parent);
        } finally {
          ctx.root.scopeFrame = false;
          ctx.root.collections = undefined;
        }
      });
    });
    if (hydrating) {
      assertHydrated(container, null, ctx);
      ctx.root.hydration!.active = false;
      ctx.root.depth--;
      flushMounts(ctx.root);
      ctx.root.hydration!.cursors.clear();
    }
  } catch (error) {
    if (ctx.root.hydration?.active) ctx.root.hydration.failed = true;
    try {
      ctx.owner.dispose();
    } catch {
      /* preserve the original mount failure */
    }
    try {
      settleRetained(ctx.root, false);
    } catch {
      /* preserve the original mount failure */
    }
    ctx.root.mounts.length = 0;
    ctx.root.errors.length = 0;
    // A supplied/retained model may outlive this failed attachment and keep its
    // source root. Cursor keys must not retain the abandoned server DOM.
    ctx.root.hydration?.cursors.clear();
    throw error;
  }
  return () =>
    runIn(ctx, () => ctx.owner.dispose()).finally(() => {
      ctx.root.mounts.length = 0;
      ctx.root.errors.length = 0;
    });
}

export function queueMount(
  ctx: UIContext,
  callback: () => void | Cleanup,
  hydrateForeign = false,
  ref = false,
): void {
  const task: MountTask = { context: ctx, callback, unregister: () => {}, hydrateForeign, ref };
  ctx.root.mounts.push(task);
  task.unregister = ctx.owner.onCleanup(() => {
    const index = ctx.root.mounts.indexOf(task);
    if (index >= 0) ctx.root.mounts.splice(index, 1);
  });
}

function typeName(definition: ModelDefinition): string {
  let name = typeNames.get(definition);
  if (!name) {
    name = definition.sid ?? definition.name ?? `anonymous:${nextTypeName++}`;
    typeNames.set(definition, name);
  }
  return name;
}

function plainProps(props: Props): Props {
  const result: Props = {};
  for (const key of Object.keys(props)) {
    if (key === "model" || key === "keep" || key === "key") continue;
    if (key === "__proto__")
      Object.defineProperty(result, key, {
        value: props[key],
        writable: true,
        configurable: true,
        enumerable: true,
      });
    else result[key] = props[key];
  }
  return result;
}

function constructorProps(props: Props): Props {
  let input = props;
  // plainProps already captured getters; only constructor values unwrap units.
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (!isReadable(value)) continue;
    if (input === props) input = { ...props };
    input[key] = value.value;
  }
  return input;
}

class ComponentProps {
  readonly #record: ComponentRecord;
  constructor(record: ComponentRecord) {
    this.#record = record;
  }
  static get(target: ComponentProps, key: PropertyKey): unknown {
    if (typeof key !== "string") return undefined;
    const record = target.#record;
    const value = record.props[key];
    return isReadable(value) ? propSlot(record, key).unit : value;
  }
  static has(target: ComponentProps, key: PropertyKey): boolean {
    return key in target.#record.props;
  }
  static keys(target: ComponentProps): (string | symbol)[] {
    return Reflect.ownKeys(target.#record.props);
  }
}
const componentPropsHandler: ProxyHandler<ComponentProps> = {
  get: ComponentProps.get,
  has: ComponentProps.has,
  ownKeys: ComponentProps.keys,
  getOwnPropertyDescriptor(target, key) {
    return ComponentProps.has(target, key) ? { configurable: true, enumerable: true } : undefined;
  },
  getPrototypeOf(target) {
    const prototype = Reflect.getPrototypeOf(target);
    return prototype === ComponentProps.prototype ? Object.prototype : prototype;
  },
  preventExtensions(target) {
    // Preserve the original plain target's prototype and Proxy invariants even
    // if reflection freezes the backing object before reporting missing keys.
    if (Reflect.getPrototypeOf(target) === ComponentProps.prototype)
      Reflect.setPrototypeOf(target, Object.prototype);
    return Reflect.preventExtensions(target);
  },
  set() {
    throw new TypeError("[ui] Component props are read-only");
  },
};
function propsFacade(record: ComponentRecord): Props {
  return new Proxy(new ComponentProps(record), componentPropsHandler) as unknown as Props;
}

function propSlot(record: ComponentRecord, key: string): PropSlot {
  let slot = record.slots?.get(key);
  if (!slot) {
    const changed = node();
    const readers = new Set<Scope>();
    const retarget = node();
    const currentSlot: PropSlot = {
      changed,
      retarget,
      readers,
      value: undefined,
      unit: {
        node: changed,
        get writable() {
          return (record.props[key] as { writable?: boolean } | undefined)?.writable === true;
        },
        get value() {
          const scope = getActiveScope();
          if (scope && isTracking()) readers.add(unwrapMicroScope(scope));
          trackNode(changed);
          return currentSlot.value;
        },
        set value(value: unknown) {
          const source = record.props[key];
          if (!isReadable(source) || (source as { writable?: boolean }).writable !== true)
            throw new TypeError("[ui] This input unit is readonly");
          markStoreTransient(source);
          (source as { value: unknown }).value = value;
        },
      } as Readable<unknown>,
    };
    slot = currentSlot;
    (record.slots ??= new Map()).set(key, currentSlot);
    bind(
      sourceContextOf(record),
      () => {
        trackNode(retarget);
        const source = record.props[key];
        return isReadable(source) ? source.value : source;
      },
      (value) => {
        if (Object.is(currentSlot.value, value)) return;
        currentSlot.value = value;
        for (const scope of readers) runDetached({ unit: changed, scope });
      },
    );
  }
  return slot;
}

function hasComponentInputs(patch: Props): boolean {
  for (const key in patch) if (key !== "id" && Object.hasOwn(patch, key)) return true;
  return false;
}

function updateComponentProps(
  record: ComponentRecord,
  patch: Props,
  ctx: UIContext,
  preserveFields = false,
): void {
  if (!hasComponentInputs(patch)) return;
  const changed: ReactiveNode[] = [];
  const inputs: string[] = [];
  let fieldPatch: Props | undefined;
  const fields = fieldKeysOf(record.definition);
  let hasChanges = false;
  for (const [key, value] of Object.entries(patch)) {
    if (key === "id") continue;
    if (
      preserveFields &&
      !isReadable(value) &&
      fields.has(key) &&
      Object.is(modelInstanceBindingOf(record.model)!.props[key], value)
    )
      continue;
    // Not a field, so the value is the input whatever the snapshot held, and
    // with no snapshot yet no slot watches it.
    if (!fields.has(key) && record.defer?.(key, value)) continue;
    if (Object.is(record.props[key], value)) continue;
    record.props[key] = value;
    hasChanges = true;
    const slot = record.slots?.get(key);
    if (slot) changed.push(slot.retarget);
    if (fields.has(key) && !record.inputs?.has(key)) {
      if (isReadable(value)) inputs.push(key);
      else (fieldPatch ??= {})[key] = value;
    }
  }
  if (fieldPatch)
    scoped(ctx.root.scope, () => record.definition.create({ id: record.model.id, ...fieldPatch }));
  for (const key of inputs) bindFieldInput(record, key);
  if (hasChanges && changed.length)
    runDetached({ unit: changed, scope: record.context!.scope });
}

function fieldKeysOf(definition: ModelDefinition): ReadonlySet<string> {
  let keys = modelFieldKeys.get(definition);
  if (!keys) {
    const names = new Set<string>();
    for (const [name, field] of definition.fields) {
      if (field.def.binding.key !== false) names.add(field.def.binding.key ?? name);
    }
    keys = names;
    modelFieldKeys.set(definition, names);
  }
  return keys;
}

/** Field keys `json()` leaves out (in-only fields): their view props are the inputs. */
function inputOnlyFieldKeysOf(definition: ModelDefinition): readonly string[] {
  let keys = inputOnlyFieldKeys.get(definition);
  if (!keys) {
    const names: string[] = [];
    for (const [name, field] of definition.fields)
      if (field.def.binding.key !== false && fieldIsOneWay(field.def))
        names.push(field.def.binding.key ?? name);
    inputOnlyFieldKeys.set(definition, (keys = names));
  }
  return keys;
}
const inputOnlyFieldKeys = new WeakMap<ModelDefinition, readonly string[]>();

/** View props from a model snapshot: the snapshot, plus inputs it does not name. */
function snapshotProps(json: Props, input: Readonly<Props>, id: string): Props {
  const props = Object.keys(input).every((key) => Object.hasOwn(json, key))
    ? json
    : { ...input, ...json };
  props.id = id;
  return props;
}

function bindFieldInput(record: ComponentRecord, key: string): void {
  if (record.inputs?.has(key)) return;
  (record.inputs ??= new Set()).add(key);
  const model = record.model;
  const binding = modelInstanceBindingOf(model)!;
  const slot = propSlot(record, key).unit;
  let initialized = false;
  bind(
    { ...record.context!, scope: binding.scope },
    () => slot.value,
    (value) => {
      if (!model.alive || !(key in record.props)) return;
      if (!initialized) {
        initialized = true;
        if (!isReadable(record.props[key])) return;
      }
      scoped(binding.homeScope, () => binding.definition.create({ id: model.id, [key]: value }));
    },
  );
}

/**
 * View props are a snapshot of the model, taken when first read: a view that
 * never reads them (or reads only `self`) needs no DTO. Default-only models
 * share their declaration defaults.
 */
class ComponentState implements ComponentRecord {
  get bindingKey(): typeof componentRecordKey {
    return componentRecordKey;
  }
  // Every slot is declared, so a record keeps one hidden class all its life.
  owner: Lifetime | undefined = undefined;
  slots: Map<string, PropSlot> | undefined = undefined;
  inputs: Set<string> | undefined = undefined;
  attachment: UIContext | undefined = undefined;
  context: UIContext | undefined = undefined;
  proxy: Props;
  committed = true;
  readonly root: RootState;
  readonly path: TreePath;
  readonly depth: number;
  readonly namespace: string;
  #props?: Props;
  #capture?: ModelViewCapture;
  #live?: ModelViewCapture;
  #input?: Readonly<Props>;
  #deferred?: Map<string, unknown>;
  readonly #id: string;

  constructor(
    readonly model: InstanceApi,
    readonly definition: ModelDefinition,
    binding: ModelInstanceBinding,
    ctx: UIContext,
  ) {
    this.#id = model.id;
    const capture = modelDefaultViewSnapshotOf(model);
    if (capture) {
      this.#capture = capture;
      this.#input = binding.props;
    } else {
      const live = modelViewCaptureOf(model);
      if (live) {
        this.#live = live;
        this.#input = binding.props;
      } else
        this.#props = snapshotProps(
          modelViewSnapshotOf(model) ?? model.json(),
          binding.props,
          this.#id,
        );
    }
    this.root = ctx.root;
    this.path = ctx.path;
    this.depth = ctx.depth;
    this.namespace = ctx.namespace;
    this.proxy = propsFacade(this);
  }
  get props(): Props {
    if (!this.#props) {
      const props = this.#live
        ? snapshotProps(this.#live.read() as Props, this.#input!, this.#id)
        : { ...this.#input, ...this.#capture!.read(), id: this.#id };
      this.#props = props;
      this.#input = undefined;
      this.#capture = undefined;
      this.#live = undefined;
      // Props set since, in order, as if set on the snapshot.
      if (this.#deferred) for (const [key, value] of this.#deferred) props[key] = value;
      this.#deferred = undefined;
    }
    return this.#props;
  }
  defer(key: string, value: unknown): boolean {
    if (this.#props) return false;
    (this.#deferred ??= new Map()).set(key, value);
    return true;
  }
  get defaultProps(): boolean {
    return this.#capture !== undefined;
  }
  /** The snapshot is not taken yet and will be `json()` of the live model. */
  get liveProps(): boolean {
    return this.#live !== undefined;
  }
}

function recordFor(
  model: InstanceApi,
  metadata: ComponentMetadata,
  binding: ModelInstanceBinding,
  ctx: UIContext,
): ComponentRecord {
  let record = componentRecordOf(model, binding);
  if (record) return record;
  const current = new ComponentState(model, metadata.model, binding, ctx);
  if (binding.setData) binding.setData(current);
  else componentRecords.set(model, current);
  // Input unit sources live with the model, not its current display. A field
  // `json()` names is a plain value in the props; only an in-only field's
  // props value is its input, possibly a unit.
  if (current.liveProps) {
    for (const key of inputOnlyFieldKeysOf(metadata.model))
      if (isReadable(binding.props[key])) bindFieldInput(current, key);
  } else if (!current.defaultProps)
    for (const key of fieldKeysOf(metadata.model))
      if (isReadable(current.props[key])) bindFieldInput(current, key);
  return current;
}

function sourceContextOf(record: ComponentRecord): UIContext {
  const ctx = (record.context ??= {
    scope: record.root.scope,
    root: record.root,
    path: record.path,
    depth: record.depth,
    namespace: record.namespace,
    nextChild: 0,
    owner: undefined!,
    afterDOM: undefined,
    component: undefined,
    values: emptyContextValues,
    document: undefined,
  });
  if (!record.owner) {
    record.model.onCleanup(() => {
      void record.owner!.dispose();
      const binding = modelInstanceBindingOf(record.model);
      if (binding?.deleteData) binding.deleteData(componentRecordKey);
      else componentRecords.delete(record.model);
    });
    record.owner = ctx.owner = lifetime();
  }
  return ctx;
}

function assertModel(
  model: unknown,
  metadata: ComponentMetadata,
  ctx: UIContext,
  resolved = false,
): asserts model is InstanceApi {
  checkModel(model, metadata, ctx, resolved);
}
/** The checks of assertModel; returns the model's binding. */
function checkModel(
  model: unknown,
  metadata: ComponentMetadata,
  ctx: UIContext,
  resolved = false,
): ModelInstanceBinding {
  if (!resolved) model = resolveModelInstance(model, ctx.root.scope);
  if (!isModelInstance(model)) throw new TypeError("[ui] model must be a Core model instance");
  const binding = modelInstanceBindingOf(model)!;
  if (binding.homeScope !== ctx.root.scope)
    throw new Error("[ui] Supplied model belongs to a different render scope");
  if (
    binding.definition !== metadata.model &&
    binding.definition["~singletonOf"] !== metadata.model
  )
    throw new Error("[ui] Supplied model has a different component model definition");
  if (!(model as InstanceApi).alive) throw new Error("[ui] Cannot display a disposed model");
  const attachment = componentRecordOf(model as object, binding)?.attachment;
  if (attachment && (!ctx.replacing || !lifetimeContains(ctx.replacing, attachment.owner)))
    throw new Error("[ui] A model instance can have only one active display");
  return binding;
}

/** Shared accessors keep optional view capabilities lazy for every attachment. */
class ViewSelf {
  readonly model: InstanceApi;
  readonly scope: Scope;
  readonly #ctx: UIContext;
  readonly #metadata: ComponentMetadata;
  readonly #record: ComponentRecord;
  readonly #binding: ModelInstanceBinding;
  #owned = false;
  #keep = false;
  #elementId?: (name: string) => string;
  #context?: <T>(target: Context<T>) => () => T;

  constructor(
    model: InstanceApi,
    binding: ModelInstanceBinding,
    metadata: ComponentMetadata,
    ctx: UIContext,
    record: ComponentRecord,
  ) {
    this.model = model;
    this.scope = binding.scope;
    this.#ctx = ctx;
    this.#metadata = metadata;
    this.#record = record;
    this.#binding = binding;
    Object.freeze(this);
  }
  get id(): string {
    return this.model.id;
  }
  /** Its model's binding: the instance a direct member reads (see `jsxMember`). */
  static binding(self: ViewSelf): ModelInstanceBinding {
    return self.#binding;
  }
  get instances(): object[] {
    return scoped(this.#ctx.root.scope, () => this.#metadata.model.instances.toArray());
  }
  get mounted(): unknown {
    return Reflect.get(this.model, "mounted");
  }
  get unmounted(): unknown {
    return Reflect.get(this.model, "unmounted");
  }
  get elementId(): (name: string) => string {
    return (this.#elementId ??= (name) => {
      if (!name) throw new TypeError("[ui] elementId requires a non-empty name");
      return `ui:${encodeURIComponent(this.#ctx.root.identifierPrefix)}:${typeName(this.#metadata.model)}:${encodeURIComponent(this.model.id)}:${encodeURIComponent(name)}`;
    });
  }
  get context(): <T>(target: Context<T>) => () => T {
    return (this.#context ??=
      <T>(target: Context<T>) =>
      () =>
        (this.#ctx.values.get(target.id)?.() ?? target.defaultValue) as T);
  }
  linkDisposal(): void {
    const binding = this.#binding;
    if (binding.addDisposalParticipant && binding.removeDisposalParticipant)
      binding.addDisposalParticipant(this);
    else linkComponentDisposal(this.#record, binding, this.#ctx);
  }
  ownAttachment(owned: boolean, keep: boolean): void {
    const binding = this.#binding;
    if (binding.addDisposalParticipant && binding.removeDisposalParticipant) {
      this.#owned = owned;
      this.#keep = keep;
      ownResource(this.#ctx.owner, this, true);
    } else ownComponentAttachment(this.#record, binding, this.#ctx, owned, keep);
  }
  beforeDispose(): void | Promise<void> {
    const ctx = this.#ctx;
    if (this.#record.attachment !== ctx || ctx.owner.closed) return;
    const pending = disposeLifetime(ctx.owner);
    return ctx.owner.closed ? undefined : pending;
  }
  [cleanupResource](): void {
    const ctx = this.#ctx,
      record = this.#record;
    this.#binding.removeDisposalParticipant!(this);
    if (record.attachment === ctx) record.attachment = undefined;
    if (!ctx.root.server && this.#owned && (!this.#keep || !record.committed) && this.model.alive)
      disposeOwnedModel(this.model, this.#binding);
  }
}

function linkComponentDisposal(
  current: ComponentRecord,
  binding: ModelInstanceBinding,
  ctx: UIContext,
): void {
  const unlink = binding.beforeDispose(() => {
    if (current.attachment !== ctx || ctx.owner.closed) return;
    const pending = disposeLifetime(ctx.owner);
    return ctx.owner.closed ? undefined : pending;
  });
  ownCleanup(ctx.owner, unlink);
}

function ownComponentAttachment(
  current: ComponentRecord,
  binding: ModelInstanceBinding,
  ctx: UIContext,
  owned: boolean,
  keep: boolean,
): void {
  ownCleanup(ctx.owner, () => {
    if (current.attachment === ctx) current.attachment = undefined;
    if (!ctx.root.server && owned && (!keep || !current.committed) && current.model.alive)
      disposeOwnedModel(current.model, binding);
  });
}

function ownCreatedModel(model: InstanceApi, binding: ModelInstanceBinding, owner: Owner): void {
  const unregister = owner.onCleanup(() => {
    if (model.alive) void disposeOwnedModel(model, binding);
  });
  model.onCleanup(unregister);
}

/** Execute a model's view once per attachment. Plain functions are view helpers. */
export function componentView(
  type: Component<any>,
  props: Props,
  ctx: UIContext,
  knownMetadata?: ComponentMetadata,
  ownPropsOnly = false,
  modelRow = false,
): Child {
  const metadata = knownMetadata ?? componentMetadataOf(type);
  if (!metadata) return type(props, ctx.component);
  // A list row's props are the runtime's own `{ model }` for a live instance.
  const supplied = modelRow
    ? (props.model as InstanceApi)
    : resolveModelInstance(ownPropsOnly ? ownProp(props, "model") : props.model, ctx.root.scope);
  if (!modelRow && isReadable(supplied))
    throw new Error("[ui] A reactive model selector needs a component region");
  if ((ownPropsOnly ? Object.hasOwn(props, "model") : "model" in props) && supplied === null)
    return null;
  let inputContext: UIContext | undefined;
  let incoming: CapturedRead<Props> | undefined;
  let identityOnly = false;
  let model: InstanceApi;
  let created = false;
  let checked: ModelInstanceBinding | undefined;
  if (supplied !== undefined) {
    checked = checkModel(supplied, metadata, ctx, true);
    model = supplied as InstanceApi;
  } else {
    inputContext = ctx.scope === ctx.root.scope ? ctx : { ...ctx, scope: ctx.root.scope };
    incoming = trackedRead(inputContext, () => plainProps(props));
    identityOnly = !hasComponentInputs(incoming.value);
    const input = identityOnly ? incoming.value : constructorProps(incoming.value);
    const local =
      (ownPropsOnly ? ownProp(props, "id") : props.id) ??
      metadata.idFromProps?.call(metadata.model, input) ??
      metadata.id?.(input);
    if (local !== undefined && (typeof local !== "string" || !local.length))
      throw new TypeError("[ui] Component id must be a non-empty creation string");
    const parent = ctx.component?.model as InstanceApi | undefined;
    const parentBinding = parent && modelInstanceBindingOf(parent);
    const id =
      local === undefined
        ? undefined
        : parent
          ? `${parentBinding!.identity}/${encodeURIComponent(local as string)}`
          : local;
    if (!parentBinding) {
      // Resolve the scope-local registry once for lookup + creation. Keep the
      // scoped task boundary around initialization (including spawned units).
      const inScope = ctx.root.scopeFrame ? runScopeFrame : scoped;
      model = inScope(ctx.root.scope, () => {
        let instances = ctx.root.collections?.get(metadata.model);
        if (!instances) {
          instances = (metadata.definitionBinding ??
            modelDefinitionBindingOf(metadata.model))!.collection(ctx.root.scope);
          if (ctx.root.scopeFrame)
            (ctx.root.collections ??= new Map()).set(metadata.model, instances);
        }
        const existing =
          typeof id === "string"
            ? instances.get
              ? instances.get(id)
              : metadata.model.get(id)
            : null;
        if (existing) {
          assertModel(existing, metadata, ctx);
          return existing as InstanceApi;
        }
        const values = id === undefined || id === input.id ? input : { ...input, id };
        const instance = (
          typeof id === "string" && identityOnly
            ? (instances[modelDefaultCreator]?.(id, values as { id: string }) ??
              instances.add(values))
            : instances.add(values)
        ) as InstanceApi;
        created = true;
        return instance;
      });
    } else {
      const existing =
        typeof id === "string" ? scoped(ctx.root.scope, () => metadata.model.get(id)) : null;
      if (existing) {
        assertModel(existing, metadata, ctx);
        model = existing;
      } else {
        const values = id === undefined || id === input.id ? input : { ...input, id };
        model = parentBinding.createOwned(metadata.model, values) as InstanceApi;
        created = true;
      }
    }
  }
  const binding = checked ?? modelInstanceBindingOf(model)!;
  let current: ComponentRecord;
  try {
    current = recordFor(model, metadata, binding, ctx);
  } catch (error) {
    if (created) {
      try {
        model.dispose();
      } catch {
        /* preserve the props-capture error */
      }
    }
    throw error;
  }
  if (created) {
    current.committed = false;
    ctx.root.models.push(current);
  }
  if (current.attachment) throw new Error("[ui] A model instance can have only one active display");
  ctx.scope = binding.scope;
  const viewSelf = new ViewSelf(model, binding, metadata, ctx, current);
  const self = viewSelf as unknown as ComponentSelf<any>;
  ctx.component = self;
  if (inputContext === ctx) inputContext = undefined;
  if (inputContext) {
    inputContext.component = self;
  }
  current.attachment = ctx;
  viewSelf.linkDisposal();
  const owned = supplied === undefined;
  if (!modelRow && (!incoming || incoming.dependencies.size || !identityOnly))
    bindComponentInputs(current, props, ctx, inputContext, owned, incoming);
  const keep =
    (ownPropsOnly ? ownProp(props, "keep") : props.keep) === undefined
      ? metadata.keep
      : (ownPropsOnly ? ownProp(props, "keep") : props.keep) === true;
  if (
    !ctx.root.server &&
    (!metadata.lifecycle || metadata.lifecycle.mounted || metadata.lifecycle.unmounted)
  ) {
    bindComponentLifecycle(current, metadata, binding, ctx);
  }
  viewSelf.ownAttachment(owned, keep);
  if (created && ctx.root.lifetime) {
    ownCreatedModel(model, binding, ctx.root.lifetime);
  }
  try {
    return runView(ctx, metadata, current.proxy, self);
  } catch (error) {
    current.attachment = undefined;
    if (created && model.alive) model.dispose();
    throw error;
  }
}

/**
 * `componentView` of a list row: a live instance of `metadata`'s model, with
 * no props besides it (what `ModelRowDescription` describes).
 */
function componentRowView(model: InstanceApi, metadata: ComponentMetadata, ctx: UIContext): Child {
  const binding = checkModel(model, metadata, ctx, true);
  const current = recordFor(model, metadata, binding, ctx);
  if (current.attachment) throw new Error("[ui] A model instance can have only one active display");
  ctx.scope = binding.scope;
  const viewSelf = new ViewSelf(model, binding, metadata, ctx, current);
  const self = viewSelf as unknown as ComponentSelf<any>;
  ctx.component = self;
  current.attachment = ctx;
  viewSelf.linkDisposal();
  if (
    !ctx.root.server &&
    (!metadata.lifecycle || metadata.lifecycle.mounted || metadata.lifecycle.unmounted)
  ) {
    bindComponentLifecycle(current, metadata, binding, ctx);
  }
  viewSelf.ownAttachment(false, metadata.keep);
  try {
    return runView(ctx, metadata, current.proxy, self);
  } catch (error) {
    current.attachment = undefined;
    throw error;
  }
}

/** A model's view, once per attachment: `runIn` with no unit declarations allowed. */
function runView(
  ctx: UIContext,
  metadata: ComponentMetadata,
  props: Props,
  self: ComponentSelf<any>,
): Child {
  const previous = activeContext;
  const previousScope = setActiveScope(ctx.scope);
  const previousOwner = setOwner(ctx.owner ?? getOwner());
  const previousSid = setSidScopeFrame(ctx.path);
  const previousTracker = setUnitDeclarationTracker(rejectViewUnit);
  activeContext = ctx;
  uiFrameDepth++;
  try {
    return metadata.view(props as never, self);
  } finally {
    uiFrameDepth--;
    setUnitDeclarationTracker(previousTracker);
    setSidScopeFrame(previousSid);
    setOwner(previousOwner);
    activeContext = previous;
    setActiveScope(previousScope);
  }
}

/** `ctx`'s frame in its root's scope, where a component's inputs are read. */
function inputFrame(ctx: UIContext): UIContext {
  return {
    scope: ctx.root.scope,
    depth: ctx.depth,
    afterDOM: ctx.afterDOM,
    owner: ctx.owner,
    document: ctx.document,
    namespace: ctx.namespace,
    values: ctx.values,
    root: ctx.root,
    path: ctx.path,
    nextChild: ctx.nextChild,
    replacing: ctx.replacing,
    component: ctx.component,
    ownedParent: ctx.ownedParent,
  };
}

function bindComponentInputs(
  current: ComponentRecord,
  props: Props,
  ctx: UIContext,
  existingInputContext: UIContext | undefined,
  owned: boolean,
  incoming?: CapturedRead<Props>,
): void {
  const inputContext = existingInputContext ?? inputFrame(ctx);
  const captured = incoming ?? trackedRead(inputContext, () => plainProps(props));
  if (!captured.dependencies.size) {
    if (hasComponentInputs(captured.value))
      runIn(inputContext, () => updateComponentProps(current, captured.value, ctx, owned));
    return;
  }
  let initial = true;
  bind(
    inputContext,
    () => plainProps(props),
    (next) => {
      const preserveFields = initial && owned;
      initial = false;
      updateComponentProps(current, next, ctx, preserveFields);
    },
    undefined,
    captured,
  );
}

function bindComponentLifecycle(
  current: ComponentRecord,
  metadata: ComponentMetadata,
  binding: ModelInstanceBinding,
  ctx: UIContext,
): void {
  const model = current.model;
  let mounted = false;
  const payload = (): LifecycleEvent => ({
    id: model.id,
    model,
    props: current.proxy,
    scope: binding.homeScope,
  });
  const unmounted = (
    metadata.lifecycle?.unmounted === false ? undefined : Reflect.get(model, "unmounted")
  ) as EventCallable<LifecycleEvent> | undefined;
  const event = (
    metadata.lifecycle?.mounted === false ? undefined : Reflect.get(model, "mounted")
  ) as EventCallable<LifecycleEvent> | undefined;
  if (unmounted?.node)
    ctx.owner.beforeDispose(() => {
      if (mounted) return runIn(ctx, () => unmounted(payload()));
    });
  if (event?.node || unmounted?.node)
    queueMount(ctx, () => {
      mounted = true;
      if (event?.node)
        void runIn(ctx, () => event(payload())).catch((error) => ctx.root.errors.push(error));
    });
}

function preflight(value: Child, ctx: UIContext): void {
  if (Array.isArray(value)) {
    for (const item of value) preflight(item, ctx);
    return;
  }
  if (!isElement(value)) return;
  if (value instanceof NativeDescription) {
    preflight(NativeDescription.children(value), ctx);
    return;
  }
  if (value instanceof TemplateDescription) {
    const template = TemplateDescription.template(value);
    if (template) {
      // Components appear in a template only as child holes.
      const values = TemplateDescription.values(value);
      for (const hole of template.childHoles) preflight(values[hole] as Child, ctx);
      return;
    }
  }
  const keyed = value instanceof KeyDescription;
  const props = keyed ? KeyDescription.source(value) : value.props;
  if (typeof value.type === "function") {
    const metadata = componentMetadataOf(value.type);
    const model = isReadable(keyed ? ownProp(props, "model") : props.model)
      ? ((keyed ? ownProp(props, "model") : props.model) as Readable<InstanceApi>).value
      : keyed
        ? ownProp(props, "model")
        : props.model;
    if (metadata && model != null) assertModel(model, metadata, ctx);
  }
  preflight((keyed ? ownProp(props, "children") : props.children) as Child, ctx);
}

function rejectViewUnit(): never {
  throw new TypeError("[ui] Declare store/computed/event/effect/reaction/action in the model, not in view");
}

function rootRemoval(root: RootState): (node: Node) => void {
  return (root.removeNode ??= (node: Node) => {
    if (root.hydration?.active || root.hydration?.failed) return;
    // While a model collection removes several instances, their rows leave
    // when it ends: a list then empties its parent at once (see `mountList`).
    const deferred = root.removals;
    if (deferred) deferred.push(node);
    else if (afterBulkRemoval(() => flushRemovals(root))) root.removals = [node];
    else node.parentNode?.removeChild(node);
  });
}
function flushRemovals(root: RootState): void {
  const deferred = root.removals!;
  root.removals = undefined;
  for (const node of deferred)
    try {
      node.parentNode?.removeChild(node);
    } catch (error) {
      root.errors.push(error);
    }
}
function ownNode(node: Node, ctx: UIContext, unique = true): void {
  ownDOMNode(ctx.owner, node, rootRemoval(ctx.root), unique);
}
/** `parent` is an element of the same lifetime: the node leaves together with it. */
function ownInner(node: Node, parent: Node, ctx: UIContext): void {
  ownInnerNode(ctx.owner, node, parent, rootRemoval(ctx.root));
}

function hydrationCursor(parent: Parent, ctx: UIContext): Node | null {
  const cursors = ctx.root.hydration!.cursors;
  if (!cursors.has(parent)) cursors.set(parent, parent.firstChild);
  return cursors.get(parent)!;
}

export function hydrationMismatch(expected: string): never {
  throw new Error(`[ui] Hydration mismatch: expected ${expected}. Use the same tree, scope snapshot, SIDs and identifierPrefix on server and client.`);
}

export function assertHydrated(parent: Parent, end: Node | null, ctx: UIContext): void {
  if (ctx.root.hydration?.active && hydrationCursor(parent, ctx) !== end)
    hydrationMismatch("end of owned content");
}

export function insert<T extends Node>(
  node: T,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
  unique = true,
): T {
  if (ctx.root.hydration?.active) return insertHydrated(node, parent, ctx, unique);
  if (before === null) parent.appendChild(node);
  else parent.insertBefore(node, before);
  if (parent === ctx.ownedParent) ownInner(node, parent, ctx);
  else ownNode(node, ctx, unique);
  return node;
}

function insertHydrated<T extends Node>(
  node: T,
  parent: Parent,
  ctx: UIContext,
  unique: boolean,
): T {
  const hydration = ctx.root.hydration!;
  let found = hydrationCursor(parent, ctx);
  if (node.nodeType === 3) {
    if (found?.nodeType !== 8 || (found as Comment).data !== "ui:t")
      hydrationMismatch("text marker");
    ownNode(found, ctx, unique);
    found = found.nextSibling;
    if (node.textContent === "" && found?.nodeType !== 3) {
      parent.insertBefore(node, found);
      found = node;
    }
    if (found?.nodeType !== 3 || found.textContent !== node.textContent)
      hydrationMismatch("matching text");
  } else if (node.nodeType === 1) {
    const expected = node as unknown as Element;
    if (
      found?.nodeType !== 1 ||
      (found as Element).localName !== expected.localName ||
      (found as Element).namespaceURI !== expected.namespaceURI
    )
      hydrationMismatch(`<${expected.localName}>`);
  } else hydrationMismatch("an element or text node");
  hydration.cursors.set(parent, found!.nextSibling);
  node = found as T;
  ownNode(node, ctx, unique);
  return node;
}

export function isElement(value: unknown): value is MarkedElement {
  return (
    value instanceof Description ||
    (typeof value === "object" && value !== null && (value as MarkedElement)[element] === true)
  );
}

export function mount(value: Child, parent: Parent, before: Node | null, ctx: UIContext): void {
  if (value == null || typeof value === "boolean") return;
  // Runtime descriptions are the common case; recognize them before duck typing.
  if (value instanceof Description && mountDescription(value as MarkedElement, parent, before, ctx))
    return;
  if (typeof value === "function") {
    mountDynamic(value, parent, before, ctx);
    return;
  }
  if (isReadable(value)) {
    mountReadable(value, parent, before, ctx);
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    insert(ctx.document!.createTextNode(String(value)), parent, before, ctx);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++)
      mountArrayEntry(value[index], index, parent, before, ctx);
    return;
  }
  if (isElement(value) && mountDescription(value, parent, before, ctx)) return;
  // ownerDocument.defaultView is absent for some detached documents; structural
  // node detection also accepts nodes from another window.
  if (typeof value === "object" && "nodeType" in value && "cloneNode" in value) {
    insert(value as Node, parent, before, ctx, false);
    return;
  }
  throw new TypeError("[ui] Unsupported child; render a primitive, JSX element or accessor");
}

/** One child of an array: its index, not a running count, names its frame. */
function mountArrayEntry(
  entry: Child,
  index: number,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
): void {
  if (entry instanceof TemplateDescription) {
    mountTemplate(entry, parent, before, ctx, index);
    return;
  }
  const type = isElement(entry) ? entry.type : undefined;
  if (typeof type === "function") {
    // Fuse the immutable array position and component attachment frames.
    // Their depth and SID path stay identical; no intermediate context lives.
    const child = childContext(ctx, index);
    child.depth++;
    const keyed = entry instanceof KeyDescription ? entry : undefined;
    mountComponent(
      type,
      keyed ? KeyDescription.source(keyed) : (entry as MarkedElement).props,
      parent,
      before,
      child,
      keyed,
    );
    return;
  }
  if (typeof type === "string") {
    const native = entry as MarkedElement;
    if (
      native instanceof OwnedDescription &&
      mountOwnedNativeLeaf(type, native.props, parent, before, ctx, index)
    )
      return;
    const item = childContext(ctx, index, false);
    if (native instanceof NativeDescription)
      mountElement(
        type,
        NativeDescription.source(native),
        parent,
        before,
        item,
        undefined,
        native,
        false,
        true,
      );
    else
      mountElement(
        type,
        native.props,
        parent,
        before,
        item,
        undefined,
        undefined,
        native instanceof OwnedDescription,
        true,
      );
    return;
  }
  const item = childContext(ctx, `item:${index}`, false);
  mount(entry, parent, before, item);
}

/** Mount one element description; false if it describes nothing this runtime knows. */
function mountDescription(
  value: MarkedElement,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
): boolean {
  if (value instanceof TemplateDescription) {
    mountTemplate(value, parent, before, ctx);
    return true;
  }
  if (value instanceof NativeDescription) {
    mountElement(
      value.type,
      NativeDescription.source(value),
      parent,
      before,
      ctx,
      undefined,
      value,
    );
    return true;
  }
  if (value instanceof KeyDescription && typeof value.type === "function") {
    mountComponent(
      value.type,
      KeyDescription.source(value),
      parent,
      before,
      childContext(ctx),
      value,
    );
    return true;
  }
  const { type, props } = value;
  if (type === Fragment) {
    mount(props.children as Child, parent, before, ctx);
    return true;
  }
  if (type === list) {
    mountList(props as unknown as ForProps<unknown>, parent, before, ctx);
    return true;
  }
  if (type === provider) {
    mountProvider(props, parent, before, ctx);
    return true;
  }
  if (type === portal) {
    mountPortal(props, parent, before, ctx);
    return true;
  }
  if (type === foreign) {
    if (foreignMount) {
      foreignMount(props as unknown as ForeignProps<unknown>, parent, before, ctx);
      return true;
    }
  }
  if (typeof type === "function") {
    mountComponent(
      type,
      props,
      parent,
      before,
      childContext(ctx),
      undefined,
      value instanceof ModelRowDescription,
    );
    return true;
  }
  if (typeof type === "string") {
    if (value instanceof OwnedDescription && mountOwnedNativeLeaf(type, props, parent, before, ctx))
      return true;
    mountElement(
      type,
      props,
      parent,
      before,
      ctx,
      undefined,
      undefined,
      value instanceof OwnedDescription,
    );
    return true;
  }
  return false;
}

function mountComponent(
  type: Component<any>,
  props: Props,
  parent: Parent,
  before: Node | null,
  child: UIContext,
  keyed?: KeyDescription,
  modelRow = false,
): void {
  try {
    const metadata = componentMetadataOf(type);
    if (keyed && !metadata) props = keyed.props;
    const ownPropsOnly = !!keyed && !!metadata;
    if (metadata && isReadable(ownPropsOnly ? ownProp(props, "model") : props.model)) {
      mountDynamic(
        () => {
          const model = (
            (ownPropsOnly ? ownProp(props, "model") : props.model) as Readable<InstanceApi | null>
          ).value;
          return model === null ? null : createElement(type, mergeProps(props, { model }));
        },
        parent,
        before,
        child,
      );
      return;
    }
    // runIn(child, …), without a closure.
    const previous = activeContext;
    const previousScope = setActiveScope(child.scope);
    const previousOwner = setOwner(child.owner ?? getOwner());
    const previousSid = setSidScopeFrame(child.path);
    activeContext = child;
    uiFrameDepth++;
    try {
      const output = componentView(type, props, child, metadata, ownPropsOnly, modelRow);
      mount(output, parent, before, child);
    } finally {
      uiFrameDepth--;
      setSidScopeFrame(previousSid);
      setOwner(previousOwner);
      activeContext = previous;
      setActiveScope(previousScope);
    }
  } catch (error) {
    try {
      child.owner.dispose();
    } catch {}
    throw error;
  }
}

/**
 * Mount a list row of a model component: what `createRow` mounting its
 * `ModelRowDescription` does, in `ctx`, which is the component's frame and
 * the row's lifetime at once (the path and depth of the component's frame,
 * with nothing of the row's own between them).
 */
export function mountModelRow(
  type: Component<any>,
  metadata: ComponentMetadata,
  model: InstanceApi,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
): void {
  if (isReadable(model)) {
    mountComponent(type, { model }, parent, before, ctx, undefined, true);
    return;
  }
  try {
    const previous = activeContext;
    const previousScope = setActiveScope(ctx.scope);
    const previousOwner = setOwner(ctx.owner ?? getOwner());
    const previousSid = setSidScopeFrame(ctx.path);
    activeContext = ctx;
    uiFrameDepth++;
    try {
      mount(componentRowView(model, metadata, ctx), parent, before, ctx);
    } finally {
      uiFrameDepth--;
      setSidScopeFrame(previousSid);
      setOwner(previousOwner);
      activeContext = previous;
      setActiveScope(previousScope);
    }
  } catch (error) {
    try {
      ctx.owner.dispose();
    } catch {}
    throw error;
  }
}

interface Region {
  start: Comment;
  end: Comment;
  context: UIContext;
  hydrating?: boolean;
}
export function regionParent(target: Region, fallback: Parent): Parent {
  // A committed fragment (or a moved host range) no longer has its original
  // parent. The live end marker is the authority for subsequent operations.
  return (target.end.parentNode as Parent | null) ?? fallback;
}
export function region(
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
  stableSegment?: string,
): Region {
  const child = childContext(ctx, stableSegment);
  if (ctx.root.hydration?.active) {
    const start = hydrationCursor(parent, ctx);
    if (start?.nodeType !== 8 || (start as Comment).data !== "ui")
      hydrationMismatch("region start marker");
    let depth = 1;
    let end = start.nextSibling;
    while (end) {
      if (end.nodeType === 8) {
        if ((end as Comment).data === "ui") depth++;
        if ((end as Comment).data === "/ui" && --depth === 0) break;
      }
      end = end.nextSibling;
    }
    if (!end) hydrationMismatch("region end marker");
    ownNode(start, child);
    ownNode(end, child);
    ctx.root.hydration.cursors.set(parent, start.nextSibling);
    return { start: start as Comment, end: end as Comment, context: child, hydrating: true };
  }
  const start = ctx.document!.createComment("ui");
  const end = ctx.document!.createComment("/ui");
  insert(start, parent, before, child);
  insert(end, parent, before, child);
  return { start, end, context: child };
}

export function finishRegion(
  target: { end: Node; context: UIContext; hydrating?: boolean },
  parent: Parent,
): void {
  if (!target.hydrating) return;
  assertHydrated(parent, target.end, target.context);
  target.context.root.hydration!.cursors.set(parent, target.end.nextSibling);
  target.hydrating = false;
}

/** A structural view can replace descriptors without replacing their live bindings. */
function propsChannel(initial: Props, ctx: UIContext) {
  let current = initial;
  const changed = node();
  const read = () => {
    trackNode(changed);
    return current;
  };
  const props = new Proxy({} as Props, {
    get: (_target, key) => Reflect.get(read(), key),
    has: (_target, key) => Reflect.has(read(), key),
    ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(read(), key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
  return {
    props,
    update(next: Props) {
      if (next === current) return;
      current = next;
      runDetached({ unit: changed, scope: ctx.scope });
    },
  };
}

/** A child value that mounts as one Text node. */
function isTextValue(value: unknown): value is string | number | bigint {
  const type = typeof value;
  return type === "string" || type === "number" || type === "bigint";
}

function isScalar(value: unknown): boolean {
  const type = typeof value;
  return (
    value == null ||
    type === "string" ||
    type === "number" ||
    type === "bigint" ||
    type === "boolean"
  );
}
function scalarText(value: unknown): string {
  return value == null || typeof value === "boolean" ? "" : String(value);
}

/**
 * The SID namespace of `ctx`'s path extended by a template frame: what the
 * path of the frame the element-by-element path would have created reads as.
 * Native bindings in templates are their own namespace object, so naming a
 * frame allocates nothing until something declares a unit in it.
 */
function framedPath(ctx: UIContext, frame: TemplateFrame | undefined): string {
  return frame ? `${ctx.path}${frame.suffix}` : String(ctx.path);
}

/** A frame's SID namespace: a path, or an object that reads as one. */
type SidFrame = string | { toString(): string };

/** `runIn`, with `sid` as the frame's SID namespace. */
function runInFrame<T>(ctx: UIContext, sid: SidFrame, callback: () => T): T {
  const previous = activeContext;
  const previousScope = setActiveScope(ctx.scope);
  const previousOwner = setOwner(ctx.owner ?? getOwner());
  const previousSid = setSidScopeFrame(sid);
  activeContext = ctx;
  uiFrameDepth++;
  try {
    return callback();
  } finally {
    uiFrameDepth--;
    setSidScopeFrame(previousSid);
    setOwner(previousOwner);
    activeContext = previous;
    setActiveScope(previousScope);
  }
}

/** `readContextValue`, with `sid` as the frame's SID namespace. */
function readFrameValue(ctx: UIContext, sid: SidFrame, source: Readable<unknown>): unknown {
  const previous = activeContext;
  const previousScope = setActiveScope(ctx.scope);
  const previousOwner = setOwner(ctx.owner ?? getOwner());
  const previousSid = setSidScopeFrame(sid);
  activeContext = ctx;
  uiFrameDepth++;
  try {
    return source.value;
  } finally {
    uiFrameDepth--;
    setSidScopeFrame(previousSid);
    setOwner(previousOwner);
    activeContext = previous;
    setActiveScope(previousScope);
  }
}

/** `readFrameValue` of a direct model member. */
function readFrameMember(
  ctx: UIContext,
  sid: SidFrame,
  member: DirectModelMember,
  instance: object,
): unknown {
  const previous = activeContext;
  const previousScope = setActiveScope(ctx.scope);
  const previousOwner = setOwner(ctx.owner ?? getOwner());
  const previousSid = setSidScopeFrame(sid);
  activeContext = ctx;
  uiFrameDepth++;
  try {
    return member.read(instance);
  } finally {
    uiFrameDepth--;
    setSidScopeFrame(previousSid);
    setOwner(previousOwner);
    activeContext = previous;
    setActiveScope(previousScope);
  }
}

/** A native writable scalar has a known source and cannot create mount work. */
class NativeTextBinding implements ReactiveNode {
  readonly priority: number;
  /** Claimed by the kernel while queued (see `queuedSlot`). */
  [queuedSlot]: unknown = undefined;
  /** Its frame, or the frame a template frame is relative to. */
  readonly #ctx: UIContext;
  readonly #frame: TemplateFrame | undefined;
  /** What it shows: a unit, or a direct model member of `#instance`. */
  readonly #source: Readable<Child> | DirectModelMember;
  readonly #instance: object | undefined;
  #text: Text;
  #sourceNode: ReactiveNode;
  #observers?: Set<ReactiveNode>;
  #meta: ReactiveNode["meta"];
  // Bit 0: inspector metadata initialized. Bit 1: this resource owns its Text.
  #flags: number;
  constructor(
    ctx: UIContext,
    source: Readable<Child> | DirectModelMember,
    text: Text,
    depth: number,
    sourceNode: ReactiveNode,
    ownsText = false,
    frame?: TemplateFrame,
    instance?: object,
  ) {
    this.#ctx = ctx;
    this.#frame = frame;
    this.#source = source;
    this.#instance = instance;
    this.#text = text;
    this.#sourceNode = sourceNode;
    this.#flags = ownsText ? 2 : 0;
    this.priority = 1 + depth;
  }
  /** The Text a template binding reads its initial value for, once it exists. */
  static setText(binding: NativeTextBinding, text: Text): void {
    binding.#text = text;
  }
  /** Its frame's SID namespace. */
  toString(): string {
    return framedPath(this.#ctx, this.#frame);
  }
  get source(): ReactiveNode {
    return this.#sourceNode;
  }
  set source(source: ReactiveNode) {
    this.#sourceNode = source;
  }
  get dependent(): ReactiveNode {
    return this;
  }
  get observers(): Set<ReactiveNode> | undefined {
    return this.#observers;
  }
  set observers(observers: Set<ReactiveNode> | undefined) {
    this.#observers = observers;
  }
  get meta(): ReactiveNode["meta"] {
    if (!(this.#flags & 1)) {
      this.#flags |= 1;
      this.#meta = { "virentia.inspector": { type: "reaction", description: "DOM binding" } };
    }
    return this.#meta;
  }
  set meta(meta: ReactiveNode["meta"]) {
    this.#flags |= 1;
    this.#meta = meta;
  }
  run(): void {
    const ctx = this.#ctx;
    if (ctx.owner.disposed) return;
    const previousContext = activeContext;
    const previousScope = setActiveScope(ctx.scope);
    const previousOwner = setOwner(ctx.owner);
    const previousSid = setSidScopeFrame(this.#frame ? this : ctx.path);
    activeContext = ctx;
    try {
      const value = this.#instance
        ? (this.#source as DirectModelMember).read(this.#instance)
        : (this.#source as Readable<Child>).value;
      if (!isScalar(value))
        throw new TypeError("[ui] A scalar binding cannot become structural; use a view fragment");
      const next = scalarText(value);
      if (this.#text.data !== next) this.#text.data = next;
    } finally {
      setSidScopeFrame(previousSid);
      setOwner(previousOwner);
      activeContext = previousContext;
      setActiveScope(previousScope);
    }
  }
  dispose(): void {
    this.#ctx.root.bindings?.delete(this);
    detachScopedDependent(this.#ctx.scope, this);
  }
  [cleanupResource](): void {
    this.dispose();
    if (this.#flags & 2) {
      const root = this.#ctx.root;
      if (!root.hydration?.active && !root.hydration?.failed)
        this.#text.parentNode?.removeChild(this.#text);
    }
  }
}

// Every native text binding shares the same terminal method. Inherit its
// registration instead of installing two identical symbol properties per node.
// The kernel still checks run identity before taking the synchronous shortcut.
registerSynchronousMethodSink(NativeTextBinding.prototype);

/**
 * An attribute, property or lone class that is one unit, observed through its
 * one node (see `fixedPropertySource`): patched like `bindAttribute` does,
 * without a binding closure or a commit frame. It is its scope's edge too.
 */
class NativePropertyBinding implements ReactiveNode {
  readonly priority: number;
  /** Claimed by the kernel while queued (see `queuedSlot`). */
  [queuedSlot]: unknown = undefined;
  /** Its frame, or the frame a template frame is relative to. */
  readonly #ctx: UIContext;
  readonly #frame: TemplateFrame | undefined;
  /** What it sets: a unit, or a direct model member of `#instance`. */
  readonly #source: Readable<unknown> | DirectModelMember;
  readonly #instance: object | undefined;
  readonly #dom: Element;
  readonly #key: string;
  #sourceNode: ReactiveNode;
  #observers?: Set<ReactiveNode>;
  #meta: ReactiveNode["meta"];
  #previous: unknown;
  constructor(
    ctx: UIContext,
    source: Readable<unknown> | DirectModelMember,
    dom: Element,
    key: string,
    sourceNode: ReactiveNode,
    initial: unknown,
    frame?: TemplateFrame,
    instance?: object,
  ) {
    this.#ctx = ctx;
    this.#frame = frame;
    this.#source = source;
    this.#instance = instance;
    this.#dom = dom;
    this.#key = key;
    this.#sourceNode = sourceNode;
    this.#previous = initial;
    this.priority = 1 + ctx.depth + (frame ? frame.depth : 0);
  }
  /** The value a template binding read before it was observed. */
  static setInitial(binding: NativePropertyBinding, initial: unknown): void {
    binding.#previous = initial;
  }
  /** Its frame's SID namespace. */
  toString(): string {
    return framedPath(this.#ctx, this.#frame);
  }
  get source(): ReactiveNode {
    return this.#sourceNode;
  }
  set source(source: ReactiveNode) {
    this.#sourceNode = source;
  }
  get dependent(): ReactiveNode {
    return this;
  }
  get observers(): Set<ReactiveNode> | undefined {
    return this.#observers;
  }
  set observers(observers: Set<ReactiveNode> | undefined) {
    this.#observers = observers;
  }
  get meta(): ReactiveNode["meta"] {
    return (this.#meta ??= domBindingMeta);
  }
  set meta(meta: ReactiveNode["meta"]) {
    this.#meta = meta;
  }
  run(): void {
    const ctx = this.#ctx;
    if (ctx.owner.disposed) return;
    const previousContext = activeContext;
    const previousScope = setActiveScope(ctx.scope);
    const previousOwner = setOwner(ctx.owner);
    const previousSid = setSidScopeFrame(this.#frame ? this : ctx.path);
    activeContext = ctx;
    try {
      const value = this.#instance
        ? (this.#source as DirectModelMember).read(this.#instance)
        : (this.#source as Readable<unknown>).value;
      if (Object.is(this.#previous, value)) return;
      this.#previous = value;
      patchProperty(this.#dom, this.#key, value);
    } finally {
      setSidScopeFrame(previousSid);
      setOwner(previousOwner);
      activeContext = previousContext;
      setActiveScope(previousScope);
    }
  }
  dispose(): void {
    this.#ctx.root.bindings?.delete(this);
    detachScopedDependent(this.#ctx.scope, this);
  }
  [cleanupResource](): void {
    this.dispose();
  }
}
registerSynchronousMethodSink(NativePropertyBinding.prototype);

/** The prop when it is one unit with a node fixed for `scope`, read as a data property. */
function fixedPropertySource(
  props: Props,
  key: string,
  scope: Scope,
): { source: Readable<unknown>; node: ReactiveNode } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(props, key);
  if (!descriptor || !("value" in descriptor) || !isReadable(descriptor.value)) return undefined;
  const source = descriptor.value as Readable<unknown>;
  const node = fixedStoreNodeOf(source, scope);
  return node && { source, node };
}

/** `bindAttribute` (or `bindElementClasses`, for a lone class) inside a mount, for one unit. */
function bindFixedProperty(
  dom: Element,
  key: string,
  fixed: { source: Readable<unknown>; node: ReactiveNode },
  ctx: UIContext,
): void {
  const source = fixed.source;
  const initial = runIn(ctx, () => source.value);
  // As there: an attribute starts unset, a class is always patched.
  if (initial !== undefined || key === "class") patchProperty(dom, key, initial);
  const observer = domObserver(
    ctx,
    new NativePropertyBinding(ctx, source, dom, key, fixed.node, initial),
  );
  ownResource(ctx.owner, observer, true);
  reconcileScopedSource(ctx.scope, observer, fixed.node, observer);
}

function bindNativeText(
  ctx: UIContext,
  source: Readable<Child>,
  text: Text,
  sourceNode: ReactiveNode,
  depth = ctx.depth,
  ownsText = false,
): void {
  const observer = domObserver(
    ctx,
    new NativeTextBinding(ctx, source, text, depth, sourceNode, ownsText),
  );
  ownResource(ctx.owner, observer, true);
  reconcileScopedSource(ctx.scope, observer, sourceNode, observer);
}

/** A scalar binding owns one permanent Text node, not a description to diff. */
function mountReadable(
  source: Readable<Child>,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
  captured?: { value: Child; fixedSource?: ReactiveNode },
): void {
  const initial = captured ? captured.value : readContextValue(ctx, source);
  if (!isScalar(initial)) {
    mountDynamic(() => source.value, parent, before, ctx);
    return;
  }
  const fixedSource = captured ? captured.fixedSource : fixedStoreNodeOf(source, ctx.scope);
  if (!ctx.root.hydration?.active && fixedSource && !ctx.afterDOM) {
    // A native scalar (a store, a computed, a model field or member, all
    // observed through one node) has no descendants that need a new context
    // frame. Preserve its tree position and priority without a frame.
    ctx.nextChild++;
    const text = ctx.document!.createTextNode(scalarText(initial));
    if (before === null) parent.appendChild(text);
    else parent.insertBefore(text, before);
    // Text inside an element of this lifetime leaves together with it. With no
    // inspector callbacks, one resource owns both the binding and Text.
    // Instrumented registration retains the separate cleanup/callback ordering.
    const inner = parent === ctx.ownedParent;
    const ownsText = !inner && !isInspectorEnabled();
    if (inner) ownInner(text, parent, ctx);
    else if (!ownsText) ownNode(text, ctx);
    bindNativeText(ctx, source, text, fixedSource, ctx.depth + 1, ownsText);
    return;
  }
  // A scalar cannot acquire structural children, so its Text node is its
  // entire range. SSR markers are only needed when claiming server content.
  const target = ctx.root.hydration?.active ? region(parent, before, ctx) : undefined;
  const content = target
    ? childContext(target.context, "0", false)
    : childContext(ctx, undefined, false);
  const text = insert(
    ctx.document!.createTextNode(scalarText(initial)),
    parent,
    target?.end ?? before,
    content,
  );
  if (fixedSource && !content.afterDOM) {
    // insert() already installed/validated the initial scalar. No dependency
    // discovery or second initial read is needed for this known native source.
    bindNativeText(content, source, text, fixedSource);
  } else
    bind(
      content,
      () => source.value,
      (value) => {
        if (!isScalar(value))
          throw new TypeError("[ui] A scalar binding cannot become structural; use a view fragment");
        const next = scalarText(value);
        if (text.data !== next) text.data = next;
      },
      fixedSource,
    );
  if (target) finishRegion(target, parent);
}

/** Structural control flow owns a replaceable range. It never compares JSX trees. */
function mountDynamic(
  read: () => Child,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
): void {
  const target = region(parent, before, ctx);
  let content: UIContext | undefined;
  // The content's Text node while it is text: a new text value patches it in place.
  let text: Text | undefined;
  let revision = 0;
  bind(
    target.context,
    () => withUnitDeclarationTracker(rejectViewUnit, read),
    (next) => {
      if (target.context.owner.closing) return;
      if (text !== undefined && isTextValue(next) && !content!.owner.closing) {
        const data = String(next);
        if (text.data !== data) text.data = data;
        return;
      }
      text = undefined;
      // Only elements and arrays have anything to check: no context copy for the rest.
      if (Array.isArray(next) || isElement(next))
        preflight(next, { ...target.context, replacing: content?.owner });
      const version = ++revision;
      const old = content;
      const attach = () => {
        if (target.context.owner.closing || revision !== version) return;
        const candidate = childContext(target.context, "0");
        try {
          runIn(candidate, () => mount(next, regionParent(target, parent), target.end, candidate));
        } catch (error) {
          void candidate.owner.dispose();
          throw error;
        }
        content = candidate;
        // Text mounts as the one node before the region's end.
        const last = target.end.previousSibling;
        if (isTextValue(next) && last?.nodeType === 3 && !target.context.root.hydration?.active)
          text = last as Text;
      };
      if (!old) {
        if (next !== undefined) attach();
        return;
      }
      const pending = old.owner.dispose();
      if (old.owner.closed) attach();
      else
        void pending
          .then(
            () => mountWork(target.context, attach),
            (error) => {
              target.context.root.errors.push(error);
              if (!target.context.owner.closing) mountWork(target.context, attach);
            },
          )
          .catch((error) => target.context.root.errors.push(error));
    },
  );
  finishRegion(target, parent);
}

export function isReadable(value: unknown): value is Readable<any> {
  return typeof value === "object" && value !== null && "node" in value && "value" in value;
}

/** Resolve only value positions; DOM callbacks and refs never go through this function. */
export function readBinding(value: unknown): unknown {
  if (typeof value === "function") return value();
  return isReadable(value) ? value.value : value;
}

export function normalizedStyle(value: unknown): unknown {
  value = readBinding(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, readBinding(value)]));
}

/** Common h() leaves need neither the general attribute nor child dispatcher. */
function mountOwnedNativeLeaf(
  tag: string,
  props: Props,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
  arrayIndex?: number,
): boolean {
  if (
    ctx.root.hydration?.active ||
    ctx.afterDOM ||
    tag.includes("-") ||
    voidElements.has(tag) ||
    rawTextElements.has(tag) ||
    hasElementProperties(props)
  )
    return false;
  const content = Object.getOwnPropertyDescriptor(props, "children");
  if (!content || !("value" in content)) return false;
  const scalar = isScalar(content.value);
  if (!scalar && (!isReadable(content.value) || tag === "select")) return false;
  const namespace = tag === "svg" ? svgNamespace : tag === "math" ? mathNamespace : ctx.namespace;
  if (scalar) mountScalarNativeLeaf(tag, content.value, namespace, parent, before, ctx, arrayIndex);
  else
    mountReadableNativeLeaf(
      tag,
      content.value as Readable<Child>,
      namespace,
      parent,
      before,
      ctx,
      arrayIndex,
    );
  return true;
}

function mountScalarNativeLeaf(
  tag: string,
  value: unknown,
  namespace: string,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
  arrayIndex?: number,
): void {
  const dom =
    namespace === htmlNamespace
      ? ctx.document!.createElement(tag)
      : ctx.document!.createElementNS(namespace, tag);
  let node: Text | undefined;
  if (value != null && typeof value !== "boolean") {
    node = ctx.document!.createTextNode(String(value));
    dom.appendChild(node);
  }
  // Immutable scalar entries cannot observe a path or create descendants.
  // Their DOM belongs directly to the enclosing lifetime, not an item frame.
  if (arrayIndex === undefined) ctx.nextChild++;
  // This native scalar has no callbacks. Fill it while detached, then retain
  // the same parent-before-text ownership order (including closed owners).
  insert(dom, parent, before, ctx);
  if (node) ownInner(node, dom, ctx);
}

function mountReadableNativeLeaf(
  tag: string,
  source: Readable<Child>,
  namespace: string,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
  arrayIndex?: number,
): void {
  let dom =
    namespace === htmlNamespace
      ? ctx.document!.createElement(tag)
      : ctx.document!.createElementNS(namespace, tag);
  const item = arrayIndex === undefined ? ctx : childContext(ctx, arrayIndex, false);
  const child = nativeElementContext(item, tag, namespace, arrayIndex !== undefined);
  dom = insert(dom, parent, before, child);
  child.ownedParent = dom;
  const value = readContextValue(child, source);
  if (!isScalar(value)) mountDynamic(() => source.value, dom, null, child);
  else {
    const fixedSource = fixedStoreNodeOf(source, child.scope);
    if (fixedSource) {
      child.nextChild++;
      const initial = scalarText(value);
      const text = child.document!.createTextNode(initial);
      dom.appendChild(text);
      ownInner(text, dom, child);
      bindNativeText(child, source, text, fixedSource, child.depth + 1);
    } else mountReadable(source, dom, null, child, { value, fixedSource });
  }
}

function hasElementProperties(props: Props): boolean {
  for (const key in props)
    if (key !== "children" && key !== "key" && Object.hasOwn(props, key)) return true;
  return false;
}

function mountElement(
  tag: string,
  props: Props,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
  existing?: Element,
  description?: NativeDescription,
  owned = false,
  reuseArrayFrame = false,
): void {
  const childProps = props;
  // h() overlays only children; native attributes can read their original live
  // source without traversing the overlay's reflective Proxy traps.
  props = childPropSources.get(props) ?? props;
  const namespace = tag === "svg" ? svgNamespace : tag === "math" ? mathNamespace : ctx.namespace;
  let dom =
    existing ??
    (namespace === htmlNamespace
      ? ctx.document!.createElement(tag)
      : ctx.document!.createElementNS(namespace, tag));
  // Static native descendants disappear with their enclosing component/range.
  // They need independent paths and namespaces, not independent lifetimes.
  const child = nativeElementContext(ctx, tag, namespace, reuseArrayFrame);
  if (tag === "select" && namespace === htmlNamespace) bindSelectSelection(child, dom, props);
  if (existing) {
    ownHostSurface(dom, child);
    child.ownedParent = undefined;
  } else {
    dom = insert(dom, parent, before, child);
    child.ownedParent = dom;
  }
  if (!owned || hasElementProperties(props)) bindElementProperties(dom, props, child);
  if (namespace === htmlNamespace && voidElements.has(tag)) {
    const content = description ? NativeDescription.children(description) : childProps.children;
    if (content != null && typeof content !== "boolean")
      throw new Error(`[ui] Void element <${tag}> cannot have children`);
  } else if (namespace === htmlNamespace && rawTextElements.has(tag)) {
    bindRawTextElement(tag, dom, props, childProps, description, child);
  } else {
    const ownContent = owned ? Object.getOwnPropertyDescriptor(childProps, "children") : undefined;
    const content = description
      ? NativeDescription.children(description)
      : ownContent && "value" in ownContent
        ? (ownContent.value as Child)
        : elementChildren(child, childProps);
    if (typeof content === "string" || typeof content === "number" || typeof content === "bigint")
      insert(child.document!.createTextNode(String(content)), dom, null, child);
    else mount(content, dom, null, child);
    assertHydrated(dom, null, child);
  }
  // Options must exist before the initial live selection is applied.
  if (tag === "select" && "value" in props) patchProperty(dom, "value", readBinding(props.value));
}

function nativeElementContext(
  ctx: UIContext,
  tag: string,
  namespace: string,
  reuse: boolean,
): UIContext {
  let child: UIContext;
  if (reuse) {
    // Array positions are private frames; retain the exact tag position.
    ctx.depth++;
    child = ctx;
  } else child = childContext(ctx, undefined, false);
  child.namespace = tag === "foreignObject" ? htmlNamespace : namespace;
  return child;
}

/**
 * Mount a compiled element. The clone carries what `mountElement` would set
 * first; frames, paths and depths follow `mountElement` and `mount` exactly.
 */
function mountTemplate(
  description: TemplateDescription,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
  arrayIndex?: number,
): void {
  const template = TemplateDescription.template(description);
  if (!template || ctx.root.hydration?.active || ctx.afterDOM || !ctx.root.depth) {
    // Hydration walks the server's nodes, a <select> applies its value after
    // each patch of its options, and read props are the source of truth: the
    // element-by-element path handles these.
    const tag = description.type;
    if (arrayIndex === undefined) mountElement(tag, description.props, parent, before, ctx);
    else
      mountElement(
        tag,
        description.props,
        parent,
        before,
        childContext(ctx, arrayIndex, false),
        undefined,
        undefined,
        false,
        true,
      );
    return;
  }
  const root = template.root;
  const tag = root.tag;
  const namespace = tag === "svg" ? svgNamespace : tag === "math" ? mathNamespace : ctx.namespace;
  const dom = Template.clone(template, ctx.document!, namespace);
  const child =
    arrayIndex === undefined
      ? nativeElementContext(ctx, tag, namespace, false)
      : nativeElementContext(childContext(ctx, arrayIndex, false), tag, namespace, true);
  insert(dom, parent, before, child);
  child.ownedParent = dom;
  if (root.live) fillTemplate(root, dom, child, TemplateDescription.values(description));
}

// While a template fills: its root element's frame, and the frames of its other
// elements, by ordinal, that something mounted through the generic path needed.
// A template mounted in a hole saves and restores both.
let fillRoot: UIContext | undefined;
let fillFrames: (UIContext | undefined)[] | undefined;
/** `rootRemoval` of the root being filled. */
let fillRemoval: ((node: Node) => void) | undefined;

/** Fill the clone of `root`, whose frame is `ctx`. */
function fillTemplate(
  root: TemplateElement,
  dom: Element,
  ctx: UIContext,
  values: readonly unknown[],
): void {
  const previousRoot = fillRoot,
    previousFrames = fillFrames,
    previousRemoval = fillRemoval;
  fillRoot = ctx;
  fillFrames = undefined;
  fillRemoval = rootRemoval(ctx.root);
  try {
    fillTemplateElement(root, dom, values);
  } finally {
    fillRoot = previousRoot;
    fillFrames = previousFrames;
    fillRemoval = previousRemoval;
  }
}

/**
 * The frame `mountElement` would have created for `node`, created now, with
 * those of its ancestors: the same path, depth, namespace and owned parent.
 */
function templateElementFrame(node: TemplateElement, dom: Element): UIContext {
  const parent = node.parent;
  if (!parent) return fillRoot!;
  const frames = (fillFrames ??= []);
  let frame = frames[node.ordinal];
  if (frame) return frame;
  const parentFrame = templateElementFrame(parent, dom.parentNode as Element);
  const tag = node.tag;
  const namespace = elementNamespace(tag, parentFrame.namespace);
  frame =
    node.index === undefined
      ? nativeElementContext(parentFrame, tag, namespace, false)
      : nativeElementContext(childContext(parentFrame, node.index, false), tag, namespace, true);
  frame.ownedParent = dom;
  frames[node.ordinal] = frame;
  return frame;
}

/**
 * `mountElement` after its DOM exists: props first, then children in order.
 * What needs no frame of its own (text, attributes and handlers set or bound
 * to one unit) names its frame instead; anything else mounts the generic way
 * in the frame that path would have created.
 */
function fillTemplateElement(
  node: TemplateElement,
  dom: Element,
  values: readonly unknown[],
): void {
  if (node.mounted.length) fillTemplateAttributes(node, dom, values);
  const children = node.children;
  if (children.length === 1) {
    // A single child: `mount(content, dom, null, element)`.
    const only = children[0];
    if (only.kind === holeChild)
      fillTemplateHole(node, dom, only, values[only.value as number], null, 0);
    else if (only.kind === elementChild) {
      const element = only.node!;
      if (element.live) {
        const ctx = fillRoot!;
        const target = dom.firstChild as Element;
        // As if inserted: an element a ref can reach leaves even when moved.
        ownInnerNode(ctx.owner, target, dom, fillRemoval!);
        fillTemplateElement(element, target, values);
      } else {
        const frame = fillFrames?.[node.ordinal];
        if (frame) frame.nextChild++;
      }
    }
    return;
  }
  // Several children: `mount(array)`, positions named by index. Holes go
  // before the next static node of the clone.
  let next = dom.firstChild;
  for (let index = 0; index < children.length; index++) {
    const entry = children[index];
    if (entry.kind === textChild) next = next!.nextSibling;
    else if (entry.kind === elementChild) {
      const element = entry.node!;
      const target = next as Element;
      next = next!.nextSibling;
      if (!element.live) continue;
      const ctx = fillRoot!;
      ownInnerNode(ctx.owner, target, dom, fillRemoval!);
      fillTemplateElement(element, target, values);
    } else if (entry.kind === holeChild)
      fillTemplateHole(node, dom, entry, values[entry.value as number], next, index);
  }
}

/** A hole child: `mount` for an only child, `mountArrayEntry` among several. */
function fillTemplateHole(
  node: TemplateElement,
  dom: Element,
  entry: TemplateChild,
  value: unknown,
  next: Node | null,
  index: number,
): void {
  // A deferred `self.model.<member>` (see `jsxMember`): bound directly, or read now.
  if (value instanceof DeferredMember) {
    if (fillTemplateMember(node, dom, entry, value, next, index)) return;
    value = DeferredMember.facade(value);
  }
  // Both mount nothing (an array position's frame holds nothing).
  if (value == null || typeof value === "boolean") return;
  const ctx = fillRoot!;
  const position = entry.frame;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    const text = ctx.document!.createTextNode(String(value));
    if (next === null) dom.appendChild(text);
    else dom.insertBefore(text, next);
    ownInnerNode(ctx.owner, text, dom, fillRemoval!);
    return;
  }
  if (typeof value === "object" && isReadable(value)) {
    // `mountReadable` of a native scalar, in its frame by name.
    const fixed = fixedStoreNodeOf(value, ctx.scope);
    if (fixed) {
      const frame = position ?? node.frame;
      const binding = new NativeTextBinding(
        ctx,
        value as Readable<Child>,
        undefined!,
        ctx.depth + frame.depth + 1,
        fixed,
        false,
        frame,
      );
      const initial = readFrameValue(ctx, binding, value);
      if (isScalar(initial)) {
        if (!position) {
          const own = fillFrames?.[node.ordinal];
          if (own) own.nextChild++;
        }
        const text = ctx.document!.createTextNode(scalarText(initial));
        if (next === null) dom.appendChild(text);
        else dom.insertBefore(text, next);
        ownInnerNode(ctx.owner, text, dom, fillRemoval!);
        NativeTextBinding.setText(binding, text);
        const observer = domObserver(ctx, binding);
        ownResource(ctx.owner, observer, true);
        reconcileScopedSource(ctx.scope, observer, fixed, observer);
        return;
      }
      // A structure: what `mountReadable` does with the value it read.
      const element = templateElementFrame(node, dom);
      mountReadable(
        value as Readable<Child>,
        dom,
        next,
        position ? childContext(element, `item:${index}`, false) : element,
        { value: initial as Child, fixedSource: fixed },
      );
      return;
    }
  }
  const element = templateElementFrame(node, dom);
  if (position) mountArrayEntry(value as Child, index, dom, next, element);
  else mount(value as Child, dom, null, element);
}

/**
 * A hole holding a view's direct model member: what `fillTemplateHole` does
 * for its facade when that is one unit with a fixed node, without creating
 * the facade unless the value is a structure. False when the member is not
 * such a unit: the hole then mounts the facade itself.
 */
function fillTemplateMember(
  node: TemplateElement,
  dom: Element,
  entry: TemplateChild,
  deferred: DeferredMember,
  next: Node | null,
  index: number,
): boolean {
  const ctx = fillRoot!;
  const member = deferred.member;
  if (member.kind === 2) return false;
  const instance = deferred.instance;
  const fixed = member.fixedNode(instance, ctx.scope);
  if (!fixed) return false;
  const position = entry.frame;
  const frame = position ?? node.frame;
  const binding = new NativeTextBinding(
    ctx,
    member,
    undefined!,
    ctx.depth + frame.depth + 1,
    fixed,
    false,
    frame,
    instance,
  );
  const initial = readFrameMember(ctx, binding, member, instance);
  if (!isScalar(initial)) {
    // A structure: `mountReadable` of the facade, with the value just read.
    const element = templateElementFrame(node, dom);
    mountReadable(
      DeferredMember.facade(deferred) as Readable<Child>,
      dom,
      next,
      position ? childContext(element, `item:${index}`, false) : element,
      { value: initial as Child, fixedSource: fixed },
    );
    return true;
  }
  if (!position) {
    const own = fillFrames?.[node.ordinal];
    if (own) own.nextChild++;
  }
  const text = ctx.document!.createTextNode(scalarText(initial));
  if (next === null) dom.appendChild(text);
  else dom.insertBefore(text, next);
  ownInnerNode(ctx.owner, text, dom, fillRemoval!);
  NativeTextBinding.setText(binding, text);
  const observer = domObserver(ctx, binding);
  ownResource(ctx.owner, observer, true);
  reconcileScopedSource(ctx.scope, observer, fixed, observer);
  return true;
}

/**
 * Mounted attributes, as `bindElementProperties` sets them: each by itself
 * when each would be (a handler, a value, or one unit bound by its node),
 * else all of them through it, in the element's frame.
 */
function fillTemplateAttributes(
  node: TemplateElement,
  dom: Element,
  values: readonly unknown[],
): void {
  const mounted = node.mounted;
  const ctx = fillRoot!;
  // Which values are one unit with a fixed node (bit per attribute): every
  // other value must be no read at all for the attributes to go directly.
  // A deferred member (see `jsxMember`) goes directly as its facade would: a
  // handler that is an event, or one unit with a fixed node (`members` bits).
  let direct = node.directAttributes;
  let units = 0;
  let members = 0;
  for (let index = 0; direct && index < mounted.length; index++) {
    const { name, kind, payload } = mounted[index];
    const value = kind === holeAttribute ? values[payload as number] : payload;
    if (value instanceof DeferredMember) {
      const member = value.member;
      if (
        name.startsWith("on")
          ? member.kind === 2
          : member.kind !== 2 && member.fixedNode(value.instance, ctx.scope)
      )
        members |= 1 << index;
      else direct = false;
      continue;
    }
    if (name.startsWith("on")) continue;
    if (typeof value === "function") direct = false;
    else if (typeof value === "object" && value !== null && isReadable(value)) {
      if (fixedStoreNodeOf(value, ctx.scope) === undefined) direct = false;
      else units |= 1 << index;
    }
  }
  if (!direct) {
    const props: Props = {};
    for (const { name, kind, payload } of mounted)
      props[name] = kind === holeAttribute ? memberValue(values[payload as number]) : payload;
    bindElementProperties(dom, props, templateElementFrame(node, dom), node.mountedKeys);
    return;
  }
  for (let index = 0; index < mounted.length; index++) {
    const { name, kind, payload } = mounted[index];
    const value = kind === holeAttribute ? values[payload as number] : payload;
    if (members & (1 << index)) {
      const { member, instance } = value as DeferredMember;
      if (name.startsWith("on")) {
        // `listen` of the member's bound callable.
        const event = eventOf(name);
        const listener = new NativeListener(ctx, member, node.frame, instance);
        dom.addEventListener(event.name, listener, event.capture);
        ownResource(ctx.owner, listener, true);
      } else
        bindTemplateProperty(
          dom,
          isClassProperty(name) ? "class" : name,
          member,
          member.fixedNode(instance, ctx.scope)!,
          ctx,
          node.frame,
          instance,
        );
    } else if (name.startsWith("on")) listen(dom, name, value, ctx, node.frame);
    else if (units & (1 << index))
      bindTemplateProperty(
        dom,
        isClassProperty(name) ? "class" : name,
        value as Readable<unknown>,
        fixedStoreNodeOf(value as object, ctx.scope)!,
        ctx,
        node.frame,
      );
    else if (isClassProperty(name)) patchProperty(dom, "class", value);
    else if (value !== undefined) patchProperty(dom, name, value);
  }
}

/** `bindFixedProperty` in a template frame named by the binding. */
function bindTemplateProperty(
  dom: Element,
  key: string,
  source: Readable<unknown> | DirectModelMember,
  node: ReactiveNode,
  ctx: UIContext,
  frame: TemplateFrame,
  instance?: object,
): void {
  const binding = new NativePropertyBinding(
    ctx,
    source,
    dom,
    key,
    node,
    undefined,
    frame,
    instance,
  );
  const initial = instance
    ? readFrameMember(ctx, binding, source as DirectModelMember, instance)
    : readFrameValue(ctx, binding, source as Readable<unknown>);
  NativePropertyBinding.setInitial(binding, initial);
  // As there: an attribute starts unset, a class is always patched.
  if (initial !== undefined || key === "class") patchProperty(dom, key, initial);
  const observer = domObserver(ctx, binding);
  ownResource(ctx.owner, observer, true);
  reconcileScopedSource(ctx.scope, observer, node, observer);
}

function elementNamespace(tag: string, namespace: string): string {
  return tag === "svg" ? svgNamespace : tag === "math" ? mathNamespace : namespace;
}

function bindRawTextElement(
  tag: string,
  dom: Element,
  props: Props,
  childProps: Props,
  description: NativeDescription | undefined,
  child: UIContext,
): void {
  bind(
    child,
    () =>
      rawText(
        tag === "textarea"
          ? "value" in props
            ? readBinding(props.value)
            : "defaultValue" in props
              ? readBinding(props.defaultValue)
              : description
                ? NativeDescription.children(description)
                : childProps.children
          : description
            ? NativeDescription.children(description)
            : childProps.children,
      ),
    (value) => {
      if (child.root.hydration?.active && dom.textContent !== value)
        hydrationMismatch(`matching <${tag}> text`);
      if (tag === "textarea") {
        const textarea = dom as HTMLTextAreaElement;
        if ("value" in props) {
          if (textarea.value !== value) textarea.value = value;
        } else if (!child.root.hydration?.active && textarea.defaultValue !== value) {
          // The browser owns an uncontrolled draft. Updating its default must
          // never copy that default back over a user-edited live value.
          textarea.defaultValue = value;
        }
      } else if (dom.textContent !== value) dom.textContent = value;
    },
  );
}

function elementChildren(child: UIContext, props: Props): Child {
  return readContextChildren(child, props);
}

function bindSelectSelection(child: UIContext, dom: Element, props: Props): void {
  const parentCommit = child.afterDOM;
  child.afterDOM = () => {
    if ("value" in props) patchProperty(dom, "value", readBinding(props.value));
    parentCommit?.();
  };
}

function ownHostSurface(dom: Element, child: UIContext): void {
  // The outer renderer owns placement/removal of this exact node. Native UI
  // owns its attributes and contents for the duration of the attachment.
  const attributes = Array.from(dom.attributes, (attribute) => ({
    name: attribute.name,
    namespace: attribute.namespaceURI,
    value: attribute.value,
  }));
  const properties = new Map<string, unknown>();
  for (const key of [
    "value",
    "defaultValue",
    "checked",
    "defaultChecked",
    "selected",
    "indeterminate",
  ]) {
    if (key in dom) properties.set(key, (dom as unknown as Props)[key]);
  }
  ownCleanup(child.owner, () => {
    dom.replaceChildren();
    for (const [key, value] of properties) (dom as unknown as Props)[key] = value;
    for (const attribute of Array.from(dom.attributes)) dom.removeAttributeNode(attribute);
    for (const attribute of attributes)
      dom.setAttributeNS(attribute.namespace, attribute.name, attribute.value);
  });
}

const classBinding = Symbol("class");
function isClassProperty(key: string): boolean {
  return key === "class" || key === "className" || key === "classList";
}

function bindAttribute(
  dom: Element,
  props: Props,
  child: UIContext,
  key: string,
  ctx: UIContext,
  captured?: CapturedRead<unknown>,
): void {
  let previous: unknown;
  if (ctx.owner !== child.owner)
    ownCleanup(ctx.owner, () => {
      if (!child.owner.disposed) patchProperty(dom, key, undefined);
    });
  const initial = captured ?? trackedRead(ctx, () => readBinding(props[key]));
  if (!initial.dependencies.size) {
    if (initial.value !== undefined)
      initialPatch(ctx, () => patchProperty(dom, key, initial.value));
    return;
  }
  bind(
    ctx,
    () => readBinding(props[key]),
    (value) => {
      if (Object.is(previous, value)) return;
      patchProperty(dom, key, value);
      previous = value;
    },
    undefined,
    initial,
  );
}

function bindElementProperty(
  dom: Element,
  props: Props,
  child: UIContext,
  key: string,
  ctx: UIContext,
): void {
  if (key !== "ref" && key !== "style" && !key.startsWith("on")) {
    bindAttribute(dom, props, child, key, ctx);
    return;
  }
  let previous: unknown;
  let remove: Cleanup | undefined;
  let listener: EventListener | undefined;
  let handler: ((event: Event) => unknown) | undefined;
  const capture = key.endsWith("Capture") && !key.startsWith("on:");
  const eventName = key.startsWith("on") ? eventOf(key).name : "";
  if (ctx.owner !== child.owner || key === "ref" || key.startsWith("on"))
    ownCleanup(ctx.owner, () => {
      remove?.();
      remove = undefined;
      handler = undefined;
      if (listener) dom.removeEventListener(eventName, listener, capture);
      listener = undefined;
      if (!child.owner.disposed && key !== "ref" && !key.startsWith("on")) {
        if (key === "style") patchStyle(dom, undefined, previous);
        else patchProperty(dom, key, undefined);
      }
    });
  bind(
    ctx,
    () =>
      key === "ref" || key.startsWith("on")
        ? props[key]
        : key === "style"
          ? normalizedStyle(props[key])
          : readBinding(props[key]),
    (value) => {
      if (Object.is(previous, value)) return;
      if (key === "ref") {
        remove?.();
        remove = undefined;
        if (isReadable(value) && (value as { writable?: boolean }).writable === true) {
          markStoreTransient(value);
          let active = true;
          remove = () => {
            active = false;
            const target = value as { value: Element | null };
            if (target.value === dom) target.value = null;
          };
          queueMount(
            ctx,
            () => {
              if (!active) return;
              const target = value as { value: Element | null };
              if (target.value && target.value !== dom)
                throw new Error("[ui] A ref store can attach to only one live DOM element");
              target.value = dom;
            },
            false,
            true,
          );
        } else if (value != null)
          throw new TypeError("[ui] ref expects a writable store of Element | null");
      } else if (key === "style") {
        patchStyle(dom, value, previous);
      } else if (key.startsWith("on")) {
        assertHandler(value);
        handler =
          typeof value === "function" ? (value as unknown as (event: Event) => unknown) : undefined;
        if (handler && !listener) {
          listener = (event) => {
            if (!ctx.owner.disposed && handler) runIn(ctx, () => handler!(event));
          };
          dom.addEventListener(eventName, listener, capture);
        } else if (!handler && listener) {
          dom.removeEventListener(eventName, listener, capture);
          listener = undefined;
        }
      } else patchProperty(dom, key, value);
      previous = value;
    },
  );
}

interface ClassValue {
  base: unknown;
  tokens: Record<string, unknown>;
}
const noClassTokens: Record<string, unknown> = Object.freeze({}) as Record<string, unknown>;
function readClasses(props: Props): ClassValue {
  let base: unknown;
  // Match SSR: when both aliases exist, the last prop wins. classList is
  // always applied afterwards, independent of its JSX/spread position.
  for (const key of Object.keys(props)) {
    if (key === "class" || key === "className") base = readBinding(props[key]);
  }
  const list = props.classList;
  const tokens =
    list === undefined
      ? noClassTokens
      : ((normalizedStyle(list) ?? noClassTokens) as Record<string, unknown>);
  return { base, tokens };
}
function patchClasses(dom: Element, next: ClassValue): void {
  patchProperty(dom, "class", next.base);
  if (next.tokens !== noClassTokens)
    for (const [name, enabled] of Object.entries(next.tokens)) {
      dom.classList.toggle(name, Boolean(enabled));
    }
}

/**
 * The source of a class that is one unit, observed through one node: the
 * element's only class prop, a data property, with no `classList`.
 */
function fixedClassSource(
  props: Props,
  keys: readonly string[],
  scope: Scope,
): { source: Readable<unknown>; node: ReactiveNode } | undefined {
  let key: string | undefined;
  for (const name of keys) {
    if (name === "classList") return undefined;
    if (name === "class" || name === "className") {
      if (key !== undefined) return undefined;
      key = name;
    }
  }
  return key === undefined ? undefined : fixedPropertySource(props, key, scope);
}

function bindElementClasses(
  dom: Element,
  props: Props,
  child: UIContext,
  ctx: UIContext,
  captured?: CapturedRead<ClassValue>,
): void {
  let previous: ClassValue | undefined;
  if (ctx.owner !== child.owner)
    ownCleanup(ctx.owner, () => {
      if (!child.owner.disposed) patchProperty(dom, "class", undefined);
    });
  bind(
    ctx,
    () => readClasses(props),
    (next) => {
      if (
        previous &&
        Object.is(previous.base, next.base) &&
        Object.keys(previous.tokens).length === Object.keys(next.tokens).length &&
        Object.entries(next.tokens).every(
          ([key, value]) =>
            Object.hasOwn(previous!.tokens, key) && Object.is(previous!.tokens[key], value),
        )
      )
        return;
      patchClasses(dom, next);
      previous = next;
    },
    undefined,
    captured,
  );
}

interface EventSpec {
  readonly name: string;
  readonly capture: boolean;
}
const eventSpecs = new Map<string, EventSpec>();
/** `onClick` → click, `onClickCapture` → click (capture), `on:my-event` → my-event. */
function eventOf(key: string): EventSpec {
  let spec = eventSpecs.get(key);
  if (!spec) {
    const capture = key.endsWith("Capture") && !key.startsWith("on:");
    let name = key.startsWith("on:")
      ? key.slice(3)
      : key.slice(2, capture ? -7 : undefined).toLowerCase();
    if (name === "doubleclick") name = "dblclick";
    eventSpecs.set(key, (spec = { name, capture }));
  }
  return spec;
}
function assertHandler(value: unknown): void {
  if (value != null && (typeof value !== "function" || !("node" in value) || "pending" in value))
    throw new TypeError("[ui] DOM handlers must be model events or actions");
}

/**
 * A static DOM handler: one object is both the native listener and its cleanup.
 * Its element belongs to the same lifetime and leaves the document with it, so
 * the cleanup only makes the listener inert instead of removing it.
 */
class NativeListener implements EventListenerObject {
  /** Its frame, or the frame a template frame is relative to; dropped once inert. */
  #ctx: UIContext | undefined;
  readonly #frame: TemplateFrame | undefined;
  /** The handler, or a direct model member (an event) of `#instance`. */
  #handler: ((event: Event) => unknown) | DirectModelMember | undefined;
  #instance: object | undefined;
  constructor(
    ctx: UIContext,
    handler: ((event: Event) => unknown) | DirectModelMember,
    frame?: TemplateFrame,
    instance?: object,
  ) {
    this.#ctx = ctx;
    this.#frame = frame;
    this.#handler = handler;
    this.#instance = instance;
  }
  /** Its frame's SID namespace. */
  toString(): string {
    return framedPath(this.#ctx!, this.#frame);
  }
  handleEvent(event: Event): void {
    const handler = this.#handler;
    const ctx = this.#ctx;
    if (!handler || !ctx || ctx.owner.disposed) return;
    const instance = this.#instance;
    runInFrame(
      ctx,
      this.#frame ? this : ctx.path,
      instance
        ? () => (handler as DirectModelMember).call(instance, event)
        : () => (handler as (event: Event) => unknown)(event),
    );
  }
  [cleanupResource](): void {
    // Nothing it held stays reachable from an element someone kept.
    this.#handler = undefined;
    this.#instance = undefined;
    this.#ctx = undefined;
  }
}
function listen(
  dom: Element,
  key: string,
  value: unknown,
  child: UIContext,
  frame?: TemplateFrame,
): void {
  assertHandler(value);
  if (typeof value !== "function") return;
  const event = eventOf(key);
  const listener = new NativeListener(child, value as (event: Event) => unknown, frame);
  dom.addEventListener(event.name, listener, event.capture);
  ownResource(child.owner, listener, true);
}

// Initial DOM reads are synchronous stack frames. Shared readers avoid creating
// keys/initializer/value closures for every element, including attribute-less leaves.
let initialPropertyDOM: Element | undefined;
let initialPropertySource: Props | undefined;
let initialPropertyKey: string | undefined;
/** A compiled element's keys: literals, so reading them tracks nothing. */
let initialPropertyKeys: readonly string[] | undefined;
const fixedKeysRead: CapturedRead<readonly string[]> = {
  value: Object.freeze([]),
  dependencies: new Set(),
};
function readInitialPropertyKeys(): string[] {
  return Object.keys(initialPropertySource!);
}
function readInitialPropertyValue(): unknown {
  return readBinding(initialPropertySource![initialPropertyKey!]);
}
function readInitialHandler(): unknown {
  return initialPropertySource![initialPropertyKey!];
}
function readInitialClasses(): ClassValue {
  return readClasses(initialPropertySource!);
}
function initializeElementProperties() {
  const child = context(),
    dom = initialPropertyDOM!,
    props = initialPropertySource!;
  const keys = initialPropertyKeys;
  const shape: CapturedRead<readonly string[]> = keys
    ? fixedKeysRead
    : collectScopedNodes(child.scope, readInitialPropertyKeys, uiReadBoundary);
  if (!shape.dependencies.size) {
    // Inside an enclosing mount, a value read without dependencies is patched
    // once; it needs no graph consumer, owner closure or commit frame.
    const direct = child.root.depth && !child.afterDOM;
    let classes = false;
    for (const key of keys ?? shape.value) {
      if (key === "children" || key === "key") continue;
      if (isClassProperty(key)) {
        if (!classes) {
          classes = true;
          const fixed = direct
            ? fixedClassSource(props, keys ?? shape.value, child.scope)
            : undefined;
          if (fixed) bindFixedProperty(dom, "class", fixed, child);
          else {
            const captured = collectScopedNodes(child.scope, readInitialClasses, uiReadBoundary);
            if (!captured.dependencies.size && direct) patchClasses(dom, captured.value);
            else bindElementClasses(dom, detachedProps(props), child, child, captured);
          }
        }
      } else if (key !== "ref" && key !== "style" && !key.startsWith("on")) {
        const fixed = direct ? fixedPropertySource(props, key, child.scope) : undefined;
        if (fixed) {
          bindFixedProperty(dom, key, fixed, child);
          continue;
        }
        initialPropertyKey = key;
        const captured = collectScopedNodes(child.scope, readInitialPropertyValue, uiReadBoundary);
        if (!captured.dependencies.size && direct) {
          if (captured.value !== undefined) patchProperty(dom, key, captured.value);
        } else bindAttribute(dom, detachedProps(props, key), child, key, child, captured);
      } else if (key.startsWith("on") && direct) {
        initialPropertyKey = key;
        const captured = collectScopedNodes(child.scope, readInitialHandler, uiReadBoundary);
        if (captured.dependencies.size) bindElementProperty(dom, props, child, key, child);
        else listen(dom, key, captured.value, child);
      } else bindElementProperty(dom, props, child, key, child);
    }
  }
  return shape;
}

/**
 * What a binding of `props` keeps: `props` itself, unless the keys it reads are
 * own data properties of an ordinary object. Those hold fixed values, so a copy
 * of them alone serves the binding without retaining the description's whole
 * `children` subtree for the element's lifetime.
 */
function detachedProps(props: Props, only?: string): Props {
  const prototype = Object.getPrototypeOf(props);
  if (prototype !== Object.prototype && prototype !== null) return props;
  const copy: Props = {};
  for (const key of Object.keys(props)) {
    if (only === undefined ? !isClassProperty(key) : key !== only) continue;
    // Accessors and proxied keys (no `value`) are read again on every update.
    const descriptor = Object.getOwnPropertyDescriptor(props, key);
    if (!descriptor || !("value" in descriptor)) return props;
    copy[key] = descriptor.value;
  }
  return copy;
}

function bindElementProperties(
  dom: Element,
  props: Props,
  child: UIContext,
  keys?: readonly string[],
): void {
  const previousDOM = initialPropertyDOM,
    previousSource = initialPropertySource,
    previousKey = initialPropertyKey,
    previousKeys = initialPropertyKeys;
  let initial: ReturnType<typeof initializeElementProperties>;
  initialPropertyDOM = dom;
  initialPropertySource = props;
  initialPropertyKeys = keys;
  try {
    initial = runIn(child, initializeElementProperties);
  } finally {
    initialPropertyDOM = previousDOM;
    initialPropertySource = previousSource;
    initialPropertyKey = previousKey;
    initialPropertyKeys = previousKeys;
  }
  if (!initial.dependencies.size) return;
  // Prop owners do not consume tree positions or change descendant identities.
  let properties: Map<string | typeof classBinding, Owner> | undefined;
  bind(
    child,
    () => Object.keys(props),
    (keys) => {
      if (!properties) {
        properties = new Map();
        ownCleanup(child.owner, () => properties!.clear());
      }
      const next = new Set<string | typeof classBinding>();
      for (const key of keys) {
        if (key !== "children" && key !== "key")
          next.add(isClassProperty(key) ? classBinding : key);
      }
      for (const [key, owner] of properties) {
        if (next.has(key)) continue;
        properties.delete(key);
        owner.dispose();
      }
      for (const key of next) {
        if (properties.has(key)) continue;
        const owner = lifetime(child.owner);
        properties.set(key, owner);
        const ctx: UIContext = { ...child, owner, depth: child.depth + 1, ownedParent: undefined };
        if (key === classBinding) bindElementClasses(dom, props, child, ctx);
        else bindElementProperty(dom, props, child, key as string, ctx);
      }
    },
    undefined,
    initial,
  );
}

export const voidElements = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" "),
);
export const rawTextElements = new Set(["textarea", "title", "script", "style"]);
export function rawText(value: unknown): string {
  if (typeof value === "function") return rawText(value());
  if (isReadable(value)) return rawText(value.value);
  if (value == null || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(rawText).join("");
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint")
    return String(value);
  throw new Error("[ui] Raw-text elements accept only primitive text children");
}

export const booleanAttributes = new Set(
  "allowfullscreen async autofocus autoplay checked controls default defer disabled formnovalidate hidden inert ismap itemscope loop multiple muted nomodule novalidate open playsinline readonly required reversed selected".split(
    " ",
  ),
);
export const svgDashedAttributes = new Set(
  "accentHeight alignmentBaseline arabicForm baselineShift capHeight clipPath clipRule colorInterpolation colorInterpolationFilters colorProfile colorRendering dominantBaseline enableBackground fillOpacity fillRule floodColor floodOpacity fontFamily fontSize fontSizeAdjust fontStretch fontStyle fontVariant fontWeight glyphName glyphOrientationHorizontal glyphOrientationVertical horizAdvX horizOriginX imageRendering letterSpacing lightingColor markerEnd markerMid markerStart overlinePosition overlineThickness paintOrder panose1 pointerEvents renderingIntent shapeRendering stopColor stopOpacity strikethroughPosition strikethroughThickness strokeDasharray strokeDashoffset strokeLinecap strokeLinejoin strokeMiterlimit strokeOpacity strokeWidth textAnchor textDecoration textRendering transformOrigin underlinePosition underlineThickness unicodeBidi unicodeRange unitsPerEm vectorEffect vertAdvY vertOriginX vertOriginY wordSpacing writingMode xHeight".split(
    " ",
  ),
);
function patchProperty(dom: Element, key: string, value: unknown): void {
  if (key === "class" || key === "className") {
    if (value == null) dom.removeAttribute("class");
    else if (dom.namespaceURI === htmlNamespace) (dom as HTMLElement).className = String(value);
    else dom.setAttribute("class", String(value));
    return;
  }
  // These attributes have no corresponding live-control or namespace rules.
  if (key.startsWith("data-") || key.startsWith("aria-")) {
    if (value == null) dom.removeAttribute(key);
    else dom.setAttribute(key, String(value));
    return;
  }
  if (key === "dangerouslySetInnerHTML" || key === "innerHTML" || key === "textContent") {
    throw new Error(`[ui] ${key} cannot be mixed with owned DOM children`);
  }
  let name = key === "className" ? "class" : key === "htmlFor" ? "for" : key;
  const html = dom.namespaceURI === htmlNamespace;
  if (html && key === "value" && Array.isArray(value) && dom.localName === "select") {
    const selected = new Set(value.map(String));
    for (const option of (dom as HTMLSelectElement).options)
      option.selected = selected.has(option.value);
    return;
  }
  if (!html && svgDashedAttributes.has(name))
    name = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  // Property writes preserve browser semantics of live controls. Avoid redundant
  // value assignments, which can otherwise move the input selection.
  if (
    html &&
    (key === "value" ||
      key === "defaultValue" ||
      key === "checked" ||
      key === "defaultChecked" ||
      key === "selected" ||
      key === "indeterminate")
  ) {
    const properties = dom as unknown as Record<string, unknown>;
    const next =
      key === "value" || key === "defaultValue"
        ? value == null
          ? ""
          : String(value)
        : Boolean(value);
    if (!Object.is(properties[key], next)) properties[key] = next;
    return;
  }
  const boolean = booleanAttributes.has(name.toLowerCase());
  if (value == null || (boolean && !value)) dom.removeAttribute(name);
  else if (boolean) dom.setAttribute(name, "");
  else if (name === "xlink:href")
    dom.setAttributeNS("http://www.w3.org/1999/xlink", name, String(value));
  else dom.setAttribute(name, String(value));
}

function patchStyle(dom: Element, value: unknown, previous: unknown): void {
  const style = (dom as HTMLElement | SVGElement).style;
  if (value == null || typeof value === "string") {
    style.cssText = value ?? "";
    return;
  }
  if (typeof previous === "string") style.cssText = "";
  const next = value as Record<string, unknown>;
  const prev =
    previous && typeof previous === "object" ? (previous as Record<string, unknown>) : {};
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const name = key.startsWith("--")
      ? key
      : key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const item = next[key];
    if (item == null) style.removeProperty(name);
    else if (!Object.is(prev[key], item)) style.setProperty(name, String(item));
  }
}

export function readSource<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

// ---------------------------------------------------------------------------
// The objects a mount creates for every row die with the rows. Keep one inert
// instance of each class, built as the mount builds them, so the code that
// handles them stays optimized after the list is cleared (see `retainShapes`
// in @virentia/core/internal).
{
  const owner = new LifetimeOwner();
  const frame = {
    owner,
    ownedParent: undefined,
    scope: undefined,
    depth: 0,
    afterDOM: undefined,
    document: undefined,
    namespace: "",
    values: emptyContextValues,
    root: undefined,
    path: "",
    nextChild: 0,
    replacing: undefined,
    component: undefined,
  } as unknown as UIContext;
  const context = new OwnedContext(frame);
  const model = { id: "", json: () => ({}) } as unknown as InstanceApi;
  const binding = { scope: undefined, props: {} } as unknown as ModelInstanceBinding;
  const record = new ComponentState(model, {} as ModelDefinition, binding, frame);
  const node = {} as ReactiveNode;
  const dom = {} as Element;
  const template = new Template(["i", 0, 0]);
  const root = createRootContext({
    scope: { values: new Map(), handlers: new Map(), deps: new Map() } as Scope,
  });
  retainShapes(
    "ui/runtime",
    root,
    inputFrame(root),
    new ChildPath("", 0),
    new ArrayChildPath("", 0),
    new TemplateDescription(template, []),
    new DeferredMember(undefined!, {}, undefined!),
    context,
    record,
    new ComponentProps(record),
    new ViewSelf(model, binding, {} as ComponentMetadata, frame, record),
    new NativeTextBinding(frame, node as never, undefined!, 0, node),
    new NativePropertyBinding(frame, node as never, dom, "", node, undefined),
    new NativeListener(frame, () => {}),
  );
}

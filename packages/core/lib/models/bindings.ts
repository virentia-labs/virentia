import type { Node } from "../kernel";
import type { Scope } from "../scope/types";
import type { ModelDefinition } from "./definition";

// Lightweight binding protocol shared with framework packages through
// @virentia/core/internal. This module deliberately has no dependency on the
// models implementation (and therefore no dependency on TypeBox).

export const modelDefinitionBinding = Symbol.for("virentia.models.definition.binding");
export const modelInstanceBinding = Symbol.for("virentia.models.instance.binding");
export const modelSingletonBinding = Symbol.for("virentia.models.singleton.binding");
/** @internal A framework namespace whose units belong to the containing model. */
export const modelValueBinding = Symbol.for("virentia.models.value.binding");

export interface ModelValueContext {
  readonly instance: ModelInstanceBinding;
  bind<T>(value: T): T;
  /** Binds a native unit/function without re-entering its namespace protocol. */
  native<T>(value: T): T;
}

export interface ModelValueBinding {
  bind(context: ModelValueContext): object;
  initialize?(context: ModelValueContext): void;
}

let scopedValueBinder: ((value: object, scope: Scope) => object) | undefined;
/** @internal Shared computed collection payloads retain their instance handles. */
export function registerModelValueScopeBinder(bind: (value: object, scope: Scope) => object): void {
  scopedValueBinder = bind;
}
export function bindModelValueInScope<T extends object>(value: T, scope: Scope): T {
  return (scopedValueBinder?.(value, scope) ?? value) as T;
}

const modelValueBindings = new WeakMap<object, ModelValueBinding>();
export function setModelValueBinding(value: object, binding: ModelValueBinding): void {
  modelValueBindings.set(value, binding);
}
export function modelValueBindingOf(value: unknown): ModelValueBinding | undefined {
  // A native reactive store interprets arbitrary symbol reads as payload reads.
  // Namespace discovery must be identity-only and safe without an active scope.
  return isObject(value) ? modelValueBindings.get(value) : undefined;
}

export interface ModelSetupContext {
  readonly kind: "static" | "dynamic";
  nextKey(prefix: string): string;
}
let activeModelSetup: ModelSetupContext | undefined;
export function getModelSetupContext(): ModelSetupContext | undefined { return activeModelSetup; }
export function setModelSetupContext(context: ModelSetupContext | undefined): ModelSetupContext | undefined {
  const previous = activeModelSetup;
  activeModelSetup = context;
  return previous;
}
/** @internal Optional identity-only constructor for native framework attachments. */
export const modelDefaultCreator = Symbol.for("virentia.models.default.creator");
export const modelViewSnapshot = Symbol.for("virentia.models.view.snapshot");
export const modelDefaultViewSnapshot = Symbol.for("virentia.models.default.view.snapshot");
/** @internal The view snapshot taken when first read, not when requested. */
export const modelViewCapture = Symbol.for("virentia.models.view.capture");
export interface ModelViewCapture {
  read(): Readonly<Record<string, unknown>>;
}
export function modelDefaultViewSnapshotOf(value: unknown): ModelViewCapture | undefined {
  return bindingOf<ModelViewCapture>(value, modelDefaultViewSnapshot);
}

/** @internal Avoid binding a public detached json method only to call it once. */
export function modelViewSnapshotOf(value: unknown): Record<string, unknown> | undefined {
  return bindingOf<Record<string, unknown>>(value, modelViewSnapshot);
}

/**
 * @internal What `modelViewSnapshotOf` returns, read only when needed: `read()`
 * serializes the live instance at that moment, untracked. Absent wherever
 * `modelViewSnapshotOf` is (a custom `json`, a non-native instance).
 */
export function modelViewCaptureOf(value: unknown): ModelViewCapture | undefined {
  return bindingOf<ModelViewCapture>(value, modelViewCapture);
}

/**
 * @internal A member of a native model instance that a compiled view binds
 * without its facade (`self.model.<name>`). It reads, or calls, exactly as the
 * facade does; a read it does not cover goes through the facade, created then.
 * `instance` is the instance's binding (`modelInstanceBindingOf`). One member
 * serves every instance of its model.
 */
export interface DirectModelMember {
  /** 0: a field; 1: a store or computed member; 2: an event or action member. */
  readonly kind: 0 | 1 | 2;
  readonly name: string;
  /** Kinds 0 and 1: the node a reader in the instance's own scope observes. */
  readonly node: Node;
  /**
   * Kinds 0 and 1: the node a renderer in `scope` may observe the member's
   * reads through, as its facade's fixed node (`fixedStoreNodeOf`) would be.
   */
  fixedNode(instance: object, scope: Scope): Node | undefined;
  /** Kinds 0 and 1: `model[name].value`. */
  read(instance: object): unknown;
  /** Kind 2: `model[name](payload)`. */
  call(instance: object, payload: unknown): unknown;
  /** Whatever reading `model[name]` does besides creating its facade. */
  access(instance: object): void;
  /** `model[name]` itself: the member's facade, created if need be. */
  facade(instance: object): unknown;
}
let directMemberResolver:
  | ((binding: object, name: string) => DirectModelMember | undefined)
  | undefined;
export function registerDirectModelMembers(
  resolver: (binding: object, name: string) => DirectModelMember | undefined,
): void {
  directMemberResolver ??= resolver;
}
/**
 * @internal The member `model[name]` would resolve to, for the model whose
 * binding is `binding`, when it can be bound directly: a native static
 * instance's field, native store or computed, or event, with no property of
 * the instance's own shadowing it.
 */
export function directModelMemberOf(binding: object, name: string): DirectModelMember | undefined {
  return directMemberResolver?.(binding, name);
}

export interface ModelSingletonBinding {
  resolve(scope: Scope): object;
}

export function modelSingletonBindingOf(value: unknown): ModelSingletonBinding | undefined {
  return bindingOf<ModelSingletonBinding>(value, modelSingletonBinding);
}

/** Materialize an unbound singleton only at a renderer's explicit scope boundary. */
export function resolveModelInstance<T>(value: T, scope: Scope): T {
  return (modelSingletonBindingOf(value)?.resolve(scope) ?? value) as T;
}

export interface ModelCollectionBinding {
  /** The optional identity input is a private renderer-owned snapshot. */
  [modelDefaultCreator]?(id: string, input?: { id: string }): object | undefined;
  readonly count: number;
  readonly first: object | null;
  /** Optional lookup for renderers; older protocol implementations may omit it. */
  get?(id: string): object | null;
  add(input: Record<string, unknown>): object;
}

export interface ModelDefinitionBinding {
  collection(scope: Scope): ModelCollectionBinding;
}

export interface ModelInstanceBinding {
  /** Native lifetime participants need no bound callback or unregister closure. */
  addDisposalParticipant?(participant: ModelDisposalParticipant): void;
  removeDisposalParticipant?(participant: ModelDisposalParticipant): void;
  /** Optional native disposal; only identical framework call sites share a trace. */
  disposeWithTrace?(trace: ModelDisposalTrace): void | Promise<void>;
  /** Optional native per-instance cache; entries are released with the model. */
  getData?(key: symbol): ModelBindingData | undefined;
  setData?(data: ModelBindingData): void;
  deleteData?(key: symbol): void;
  /** Scope that isolates this model instance's static units. */
  readonly scope: Scope;
  /** Application scope; an instance scope is not a separate application. */
  readonly homeScope: Scope;
  readonly definition: ModelDefinition;
  readonly identity: string;
  readonly props: Readonly<Record<string, unknown>>;
  beforeDispose(callback: () => void | PromiseLike<unknown>): () => void;
  adopt(child: object): void;
  createOwned(definition: ModelDefinition, props: Record<string, unknown>): object;
  subscribe(listener: () => void): () => void;
}

export interface ModelDisposalParticipant {
  beforeDispose(): void | PromiseLike<unknown>;
}

/** Store strings, never an Error that could retain a renderer's closure frames. */
export interface ModelDisposalTrace {
  stack?: string;
}

export interface ModelBindingData {
  readonly bindingKey: symbol;
}

export interface ModelVersionBinding {
  subscribe(listener: () => void): () => void;
}

export interface ModelQueryBinding {
  readonly "~query": true;
  readonly "~versions": () => ModelVersionBinding[];
}

export function modelDefinitionBindingOf(value: unknown): ModelDefinitionBinding | undefined {
  return bindingOf<ModelDefinitionBinding>(value, modelDefinitionBinding);
}

export function modelInstanceBindingOf(value: unknown): ModelInstanceBinding | undefined {
  return bindingOf<ModelInstanceBinding>(value, modelInstanceBinding);
}

export function modelQueryBindingOf(value: unknown): ModelQueryBinding | undefined {
  if (!isObject(value)) return undefined;

  const candidate = value as Partial<ModelQueryBinding>;

  return candidate["~query"] === true && typeof candidate["~versions"] === "function"
    ? (candidate as ModelQueryBinding)
    : undefined;
}

function bindingOf<Binding>(value: unknown, key: symbol): Binding | undefined {
  if (!isObject(value)) return undefined;

  return (value as Record<symbol, Binding | undefined>)[key];
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

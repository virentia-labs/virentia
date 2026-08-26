import { trackNode } from "../graph/deps";
import { owner } from "../graph/owner";
import type { Owned, Owner } from "../graph/owner";
import { setReactionConfigTransform } from "../graph/reaction";
import { getActiveScope, runScopeTask } from "../scope/internal";
import { unwrapMicroScope } from "../scope/micro";
import type { Scope } from "../scope/types";
import { seedScopeStoreValue, store } from "../units/store";
import type { StoreWritable } from "../units/store";
import { modelInstanceBinding, type ModelInstanceBinding } from "./bindings";
import { composeShape, resolveDataDeclaration } from "./trait";
import type { DataDeclaration, TraitDef } from "./trait";
import { fieldIsOneWay, fieldOut } from "./fields";
import type { FieldDef } from "./fields";
import { Self, isInverseDef, isRelationDef } from "./relations";
import type { InverseDef, RelationDef } from "./relations";
import type {
  AnyTraitTyped,
  Instance,
  LocalizeUnbound,
  MembersRecord,
  ModelWithDescriptors,
  SelfOf,
  ShapeRecord,
  TraitsMembers,
  TraitsProps,
  TraitsRequiredBehaviors,
  TraitsShape,
} from "./types";
import type { Props } from "./fields";

// §3: two model kinds with one declaration form and one usage surface. `data`
// resolves ONCE for both; the kinds differ in unit instantiation only:
//   model        — stores and units are created per instance (setup(self, props));
//   staticModel  — stores and units exist once, an instance is a scope (setup(self)).

export interface ModelConfig {
  with?: readonly TraitDef[];
  data?: DataDeclaration;
  setup?: (self: never, props?: never) => Record<string, unknown> | void;
  name?: string;
}

export type ModelKind = "dynamic" | "static";

export interface FieldRuntime {
  readonly name: string;
  readonly def: FieldDef;
  /** static: the single store shared by the collection; dynamic: created per instance. */
  readonly staticStore?: StoreWritable<unknown>;
}

export interface RelationRuntime {
  readonly name: string;
  readonly def: RelationDef;
  /** backing state: target id (one) or ordered id list (many). */
  readonly staticStore?: StoreWritable<unknown>;
}

export interface InverseRuntime {
  readonly name: string;
  readonly def: InverseDef;
}

export interface ModelDefinition {
  readonly "~model": true;
  readonly kind: ModelKind;
  readonly name?: string;
  readonly fields: ReadonlyMap<string, FieldRuntime>;
  readonly relations: ReadonlyMap<string, RelationRuntime>;
  readonly inverses: ReadonlyMap<string, InverseRuntime>;
  readonly behaviors: ReadonlySet<string>;
  readonly traits: readonly TraitDef[];
  /** field → declaring trait identity; drives union commonality (§5.2). */
  readonly fieldOrigins: ReadonlyMap<string, TraitDef>;
  /** static only: members produced by trait setups + model setup, shared by all instances. */
  readonly staticMembers?: ReadonlyMap<string, unknown>;
  readonly setup?: ModelConfig["setup"];
  /** static only: ids of instance-local store state for scope routing (§3.2). */
  readonly locals?: ReadonlySet<unknown>;
  create(props: Record<string, unknown>): unknown;
}

const definitionBrand = Symbol("virentia.models.definition");
const RESERVED = new Set([
  // instance API (§3.1)
  "id", "key", "alive", "json", "toJSON", "dispose", "rebind", "onCleanup",
  // definition surface (§4.6)
  "create", "name", "kind", "fields", "relations", "inverses", "behaviors", "traits",
  "staticMembers", "setup", "locals", "fieldOrigins",
]);

export function isModelDefinition(value: unknown): value is ModelDefinition {
  return typeof value === "object" && value !== null && definitionBrand in value;
}

/** Is this value an instance facade produced by a collection? (§10.1) */
export function isModelInstance(value: unknown): boolean {
  return typeof value === "object" && value !== null && instanceInternals.has(value);
}

// ---------------------------------------------------------------------------
// Instance-scope values: a Map that routes by static ownership (§3.2). Keys in
// `locals` (the model's field state) live in the instance's own map; everything
// else falls through to the parent scope — one `has` per access, no chain walk.
// Implemented as a Map subclass so the kernel needs no changes at all.

class ChainedValues extends Map<unknown, unknown> {
  constructor(
    private readonly parent: Map<unknown, unknown>,
    private readonly locals: ReadonlySet<unknown>,
  ) {
    super();
  }

  // Plain-store state is classified by its id symbol: anything that is not the
  // model's own field belongs to the application scope, ALWAYS — first touch
  // must not decide locality, or an app store read from an instance context
  // forks into a permanent per-instance shadow. Computed caches and other
  // per-scope state stay instance-local for isolation.
  private isForeignStore(key: unknown): boolean {
    return (
      !this.locals.has(key) &&
      typeof key === "symbol" &&
      key.description === "virentia.store"
    );
  }

  override get(key: unknown): unknown {
    if (this.isForeignStore(key)) return this.parent.get(key);

    return super.get(key);
  }

  override has(key: unknown): boolean {
    if (this.isForeignStore(key)) return this.parent.has(key);

    return super.has(key);
  }

  override set(key: unknown, value: unknown): this {
    if (this.isForeignStore(key)) {
      this.parent.set(key, value);
      return this;
    }

    super.set(key, value);
    return this;
  }

  override delete(key: unknown): boolean {
    return super.delete(key);
  }
}

export function createInstanceScope(parent: Scope, locals: ReadonlySet<unknown>): Scope {
  return {
    values: new ChainedValues(parent.values, locals) as Scope["values"],
    handlers: parent.handlers,
    deps: parent.deps,
  };
}

// ---------------------------------------------------------------------------
// Instance internals

export interface InstanceInternal {
  readonly definition: ModelDefinition;
  readonly parentScope: Scope;
  /** static only */
  readonly scope?: Scope;
  /** dynamic only: per-instance stores and members */
  ownStores?: ReadonlyMap<string, StoreWritable<unknown>>;
  ownMembers?: ReadonlyMap<string, unknown>;
  ownOwner?: Owned<object>;
  id: string;
  /** UI key — slot+generation (§10.1); stable across rebind, unique across reuse. */
  readonly key: string;
  /** §3.5: the handle IS { slot, generation } — a reused slot bumps the generation. */
  readonly slot: number;
  readonly generation: number;
  alive: boolean;
  temporaryId: boolean;
  /** §3.5: where the dispose happened. Kept as an Error — the allocation is
   * cheap and V8 builds the stack STRING lazily, only if a stale access throws. */
  disposedSite?: Error;
  /** §3.5: reactive `alive` — registers an epoch dependency in the caller. */
  onAliveRead?: () => void;
  /** §10.4: external cleanups registered via `onCleanup` — run at dispose,
   * while the instance is still readable, before teardown. Lazy: only
   * instances that register pay. */
  disposers?: Set<() => void>;
  /** binding seam (§10.1): per-instance change feed — own field/relation
   * writes, dispose and rebind; attach/detach managed by the collection. */
  subscribeSelf?: (listener: () => void) => () => void;
  notifySelf?: () => void;
  onWrite?: (name: string, value: unknown) => void;
  onRebind?: (oldId: string, newId: string) => void;
  onDispose?: (instance: InstanceInternal) => void;
  /** relation/inverse views, provided by the collection (avoids a module cycle). */
  relationView?: (name: string) => object;
  /** relation wire output, provided by the collection (§9.1: children inline, refs by id). */
  serializeRelations?: (out: Record<string, unknown>) => void;
}

const instanceInternals = new WeakMap<object, InstanceInternal>();
/** static: instance-scope → internal, resolved by ambient-self and field subscriptions. */
const scopeInstances = new WeakMap<Scope, InstanceInternal>();

export function registerScopeInstance(scope: Scope, internal: InstanceInternal): void {
  scopeInstances.set(scope, internal);
}

/** Injected by collection.ts: live instances of a definition in a (normalized) scope. */
let broadcastResolver:
  | ((definition: ModelDefinition, scope: Scope) => readonly InstanceInternal[])
  | null = null;

export function setBroadcastResolver(resolver: typeof broadcastResolver): void {
  broadcastResolver = resolver;
}

let idCounter = 0;

export function instanceInternalOf(instance: object): InstanceInternal | undefined {
  return instanceInternals.get(instance);
}

export function instanceOfScope(scope: Scope): InstanceInternal | undefined {
  return scopeInstances.get(unwrapMicroScope(scope));
}

export function generateId(): string {
  idCounter += 1;

  return `~tmp${idCounter}`;
}

/** First frame outside this package's own dispose plumbing — the culprit. */
function formatDisposeSite(stack: string | undefined): string | undefined {
  if (!stack) return undefined;

  for (const line of stack.split("\n").slice(1)) {
    const frame = line.trim();

    if (!frame.startsWith("at ")) continue;

    if (
      frame.includes("models/collection") ||
      frame.includes("models/definition") ||
      frame.includes("models/union") ||
      frame.includes("disposeInstance")
    ) {
      continue;
    }

    return frame.slice(3);
  }

  return undefined;
}

/** §10.4: attach an external cleanup (a socket, a marker, an unsubscribe) to
 * the INSTANCE's lifetime. Runs at dispose while fields are still readable. */
export function registerInstanceCleanup(
  internal: InstanceInternal,
  cleanup: () => void,
): () => void {
  requireAlive(internal);
  (internal.disposers ??= new Set()).add(cleanup);

  return () => {
    internal.disposers?.delete(cleanup);
  };
}

/** Disposal must complete: a failing cleanup is reported, not propagated. */
export function runInstanceDisposers(internal: InstanceInternal): void {
  if (!internal.disposers) return;

  for (const cleanup of [...internal.disposers]) {
    try {
      cleanup();
    } catch (error) {
      if (typeof console !== "undefined") {
        // eslint-disable-next-line no-console
        console.error("[models] onCleanup handler failed:", error);
      }
    }
  }

  internal.disposers.clear();
}

function requireAlive(internal: InstanceInternal): void {
  if (!internal.alive) {
    // §3.5: the throw fires in an innocent read — it carries the dispose site,
    // or the evidence about the culprit is gone with the instance.
    const site = formatDisposeSite(internal.disposedSite?.stack);

    throw new Error(`[models] entity was disposed${site ? ` — disposed at ${site}` : ""}`);
  }
}

function fieldStoreFor(internal: InstanceInternal, name: string): StoreWritable<unknown> {
  const runtime = internal.definition.fields.get(name);

  if (!runtime) throw new Error(`[models] unknown field "${name}"`);

  return internal.definition.kind === "static"
    ? (runtime.staticStore as StoreWritable<unknown>)
    : (internal.ownStores!.get(name) as StoreWritable<unknown>);
}

function runInInstance<T>(internal: InstanceInternal, fn: () => T): T {
  const scope = internal.definition.kind === "static" ? internal.scope! : internal.parentScope;

  return runScopeTask(scope, fn);
}

/** Collection-side access to the instance context and relation backing stores. */
export function runInInstanceContext<T>(internal: InstanceInternal, fn: () => T): T {
  return runInInstance(internal, fn);
}

export function relationStoreFor(internal: InstanceInternal, name: string): StoreWritable<unknown> {
  const runtime = internal.definition.relations.get(name);

  if (!runtime) throw new Error(`[models] unknown relation "${name}"`);

  return internal.definition.kind === "static"
    ? (runtime.staticStore as StoreWritable<unknown>)
    : (internal.ownStores!.get(name) as StoreWritable<unknown>);
}

/** The per-field facade on the instance: the same store surface as `self.x` in setup (§8). */
function createFieldFacade(internal: InstanceInternal, name: string): object {
  const storeUnit = fieldStoreFor(internal, name);

  return {
    get value(): unknown {
      requireAlive(internal);
      // Register the dependency while the CALLER's collector/micro-scope is
      // still ambient — runScopeTask replaces the scope, so a read inside an
      // auto-reaction would otherwise track nothing and never re-run.
      trackNode((storeUnit as unknown as { node: never }).node);

      return runInInstance(internal, () => storeUnit.value);
    },

    set value(next: unknown) {
      requireAlive(internal);
      runInInstance(internal, () => {
        storeUnit.value = next;
      });
      internal.onWrite?.(name, next);
    },

    get node() {
      return (storeUnit as { node?: unknown }).node;
    },

    subscribe(fn: (value: unknown, scope: Scope) => void): () => void {
      return storeUnit.subscribe((value, scope) => {
        if (internal.definition.kind === "dynamic" || instanceOfScope(scope) === internal) {
          fn(value, scope);
        }
      });
    },
  };
}

function memberOf(internal: InstanceInternal, name: string): unknown {
  const members =
    internal.definition.kind === "static"
      ? internal.definition.staticMembers
      : internal.ownMembers;

  return members?.get(name);
}

function isStoreLike(value: unknown): value is { value: unknown; node: never; subscribe: never } {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "node" in (value as object) &&
    "subscribe" in (value as object)
  );
}

function wrapMember(internal: InstanceInternal, member: unknown): unknown {
  // A computed (or any store-surfaced unit) returned from setup must read in
  // the INSTANCE scope, not the caller's — otherwise it evaluates against the
  // shared declaration defaults and caches into the wrong scope.
  if (isStoreLike(member)) {
    const unit = member as { value: unknown; node: never };

    return {
      get value(): unknown {
        requireAlive(internal);
        trackNode(unit.node);

        return runInInstance(internal, () => unit.value);
      },

      get node() {
        return unit.node;
      },

      subscribe(fn: (value: unknown, scope: Scope) => void): () => void {
        return (member as { subscribe: (f: typeof fn) => () => void }).subscribe((value, scope) => {
          if (internal.definition.kind === "dynamic" || instanceOfScope(scope) === internal) {
            fn(value, scope);
          }
        });
      },
    };
  }

  if (typeof member !== "function") return member;

  return (...args: unknown[]) => {
    requireAlive(internal);

    return runInInstance(internal, () => (member as (...a: unknown[]) => unknown)(...args));
  };
}

export function createInstanceFacade(internal: InstanceInternal): object {
  const facades = new Map<string, object>();
  const wrapped = new Map<string, unknown>();

  const target = {
    get id(): string {
      return internal.id;
    },

    get key(): string {
      return internal.key;
    },

    get alive(): boolean {
      // never throws — the whole point is degrading without a try (§3.5); the
      // hook makes the read reactive by tracking the collection epoch
      internal.onAliveRead?.();

      return internal.alive;
    },

    json(): Record<string, unknown> {
      requireAlive(internal);

      return serializeInstance(internal);
    },

    toJSON(): Record<string, unknown> {
      return this.json();
    },

    dispose(): void {
      if (!internal.alive) return;

      internal.onDispose?.(internal);
    },

    onCleanup(cleanup: () => void): () => void {
      return registerInstanceCleanup(internal, cleanup);
    },

    rebind(newId: string): void {
      requireAlive(internal);

      const oldId = internal.id;

      if (oldId === newId) return;

      internal.id = newId;
      internal.temporaryId = false;
      internal.onRebind?.(oldId, newId);
    },
  };

  Object.defineProperty(target, modelInstanceBinding, {
    value: {
      subscribe(listener) {
        return internal.subscribeSelf?.(listener) ?? (() => {});
      },
    } satisfies ModelInstanceBinding,
  });

  const facade = new Proxy(target, {
    get(base, property, receiver) {
      if (typeof property !== "string" || property in base || property === "then") {
        return Reflect.get(base, property, receiver);
      }

      if (internal.definition.fields.has(property)) {
        let cached = facades.get(property);

        if (!cached) {
          cached = createFieldFacade(internal, property);
          facades.set(property, cached);
        }

        return cached;
      }

      if (
        internal.definition.relations.has(property) ||
        internal.definition.inverses.has(property)
      ) {
        requireAlive(internal);

        return internal.relationView!(property);
      }

      const member = memberOf(internal, property);

      if (member !== undefined) {
        let cached = wrapped.get(property);

        if (cached === undefined) {
          cached = wrapMember(internal, member);
          wrapped.set(property, cached);
        }

        return cached;
      }

      return undefined;
    },

    has(base, property) {
      return (
        property in base ||
        (typeof property === "string" &&
          (internal.definition.fields.has(property) ||
            internal.definition.relations.has(property) ||
            internal.definition.inverses.has(property) ||
            memberOf(internal, property) !== undefined))
      );
    },
  });

  instanceInternals.set(facade, internal);

  return facade;
}

function serializeInstance(internal: InstanceInternal): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (!internal.temporaryId) {
    // Autogenerated ids never serialize (§10.1) — the server assigns its own.
    out.id = internal.id;
  }

  for (const [name, runtime] of internal.definition.fields) {
    const binding = runtime.def.binding;

    if (binding.key === false) continue;

    if (fieldIsOneWay(runtime.def)) {
      if (!binding.inOnly && typeof console !== "undefined") {
        // eslint-disable-next-line no-console
        console.warn(
          `[models] field "${name}" is bound with an in-transform only and was omitted from json(); add an out-transform or mark .inOnly() (§9.1)`,
        );
      }

      continue;
    }

    const key = binding.key === null ? name : binding.key;
    const storeUnit = fieldStoreFor(internal, name);
    const value = runInInstance(internal, () => storeUnit.value);

    out[key] = fieldOut(runtime.def, value);
  }

  internal.serializeRelations?.(out);

  return out;
}

// ---------------------------------------------------------------------------
// The ambient `self` for static setup: fields resolve to the shared stores (the
// active scope picks the instance), members resolve lazily, instance API
// resolves the ambient instance and errors outside unit bodies (§3.1).

function createStaticSelf(
  fields: ReadonlyMap<string, FieldRuntime>,
  relations: ReadonlyMap<string, RelationRuntime>,
  inverses: ReadonlyMap<string, InverseRuntime>,
  members: Map<string, unknown>,
): object {
  const requireAmbient = (operation: string): InstanceInternal => {
    const scope = getActiveScope();
    const internal = scope ? instanceOfScope(scope) : undefined;

    if (!internal) {
      throw new Error(
        `[models] self.${operation} needs an instance context — it is only available inside unit bodies (reactions, effects), not in the setup body itself (§3.1)`,
      );
    }

    return internal;
  };

  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property !== "string") return undefined;

      const runtime = fields.get(property);

      if (runtime) return runtime.staticStore;

      if (relations.has(property) || inverses.has(property)) {
        const internal = requireAmbient(property);

        requireAlive(internal);

        return internal.relationView!(property);
      }

      if (property === "id") return requireAmbient("id").id;
      if (property === "key") return requireAmbient("key").key;

      if (property === "alive") {
        const internal = requireAmbient("alive");

        internal.onAliveRead?.();

        return internal.alive;
      }

      if (property === "json") {
        return () => {
          const internal = requireAmbient("json()");

          requireAlive(internal);

          return serializeInstance(internal);
        };
      }

      if (property === "rebind") {
        return (newId: string) => {
          const internal = requireAmbient("rebind()");

          requireAlive(internal);

          const oldId = internal.id;

          if (oldId === newId) return;

          internal.id = newId;
          internal.temporaryId = false;
          internal.onRebind?.(oldId, newId);
        };
      }

      if (property === "dispose") {
        return () => {
          const internal = requireAmbient("dispose()");

          internal.onDispose?.(internal);
        };
      }

      if (property === "onCleanup") {
        // The per-instance cleanup tool for STATIC models (§10.4): a unit body
        // subscribes to something external and ties the unsubscribe to the
        // ambient instance — no store, no per-instance units.
        return (cleanup: () => void) =>
          registerInstanceCleanup(requireAmbient("onCleanup()"), cleanup);
      }

      return members.get(property);
    },
  });
}

// ---------------------------------------------------------------------------
// Definitions

function validateShape(fields: ReadonlyMap<string, unknown>): void {
  for (const name of fields.keys()) {
    if (RESERVED.has(name)) {
      throw new Error(
        `[models] field "${name}" collides with the instance/definition API (§4.6) — rename it`,
      );
    }
  }
}

function relationDefault(def: RelationDef): unknown {
  return def.cardinality === "many" ? [] : null;
}

function createBroadcastRouter(
  publicDefinition: () => ModelDefinition,
): <C extends { run: (...args: never[]) => unknown }>(config: C) => C {
  return (config) => ({
    ...config,
    run: (...args: never[]) => {
      const active = getActiveScope();
      const unwrapped = active ? unwrapMicroScope(active) : null;
      const ambient = unwrapped ? instanceOfScope(unwrapped) : undefined;
      const definition = publicDefinition();

      if (ambient && publicOf(ambient.definition) === definition) {
        // per-instance path: an own unit fired through an instance facade
        return config.run(...args);
      }

      if (!broadcastResolver || !unwrapped) return config.run(...args);

      // §3.4 broadcast: normalize past a foreign instance scope, walk the live
      // instances of THIS model in that scope, run in each instance scope.
      let home = unwrapped;
      let foreign = instanceOfScope(home);

      while (foreign) {
        home = unwrapMicroScope(foreign.parentScope);
        foreign = instanceOfScope(home);
      }

      for (const instance of broadcastResolver(definition, home)) {
        if (!instance.alive || !instance.scope) continue;

        runScopeTask(instance.scope, () => config.run(...args));
      }

      return undefined;
    },
  });
}

function publicOf(definition: ModelDefinition): ModelDefinition {
  return (
    (definition as unknown as { "~public"?: ModelDefinition })["~public"] ?? definition
  );
}

function buildDefinition(kind: ModelKind, config: ModelConfig): ModelDefinition {
  const ownData = resolveDataDeclaration(config.data);
  const shape = composeShape(config.with ?? [], ownData.fields, ownData.relations);
  const declared = new Map<string, unknown>([...shape.fields, ...shape.relations]);

  validateShape(declared as ReadonlyMap<string, FieldDef>);

  const fields = new Map<string, FieldRuntime>();
  const relations = new Map<string, RelationRuntime>();
  const inverses = new Map<string, InverseRuntime>();
  const locals = new Set<unknown>();
  let staticMembers: Map<string, unknown> | undefined;

  // Relation defs are cloned per definition: a trait's RelationDef is shared by
  // every model composing it, but Self resolution and the target cache are
  // per-model (§5.4).
  const cloneRelations = (definitionRef: () => ModelDefinition): void => {
    for (const [name, entry] of shape.relations) {
      if (isInverseDef(entry)) {
        inverses.set(name, { name, def: { ...entry, resolved: undefined } });
        continue;
      }

      const def: RelationDef = { ...entry, resolvedTarget: undefined };

      Object.defineProperty(def, "owner", {
        configurable: true,
        get: () => {
          const raw = definitionRef() as unknown as { "~public"?: ModelDefinition };

          return raw["~public"] ?? definitionRef();
        },
      });

      if (kind === "static") {
        const staticStore = store<unknown>(relationDefault(def), undefined, {
          name: config.name ? `${config.name}.${name}` : name,
        });

        relations.set(name, { name, def, staticStore });
        locals.add(storeStateId(staticStore));
      } else {
        relations.set(name, { name, def });
      }
    }
  };

  cloneRelations(() => definition);

  if (kind === "static") {
    for (const [name, def] of shape.fields) {
      const staticStore = store<unknown>(def.defaultValue?.value, undefined, {
        name: config.name ? `${config.name}.${name}` : name,
      });

      fields.set(name, { name, def, staticStore });
      locals.add(storeStateId(staticStore));
    }

    staticMembers = new Map();

    const self = createStaticSelf(fields, relations, inverses, staticMembers);
    const previousTransform = setReactionConfigTransform(
      createBroadcastRouter(() => publicOf(definition)),
    );

    try {
      for (const traitDef of shape.traits) {
        const returned = traitDef.setup?.(self as never);

        mergeMembers(staticMembers, returned, declared);
      }

      const returned = config.setup?.(self as never);

      mergeMembers(staticMembers, returned, declared);
    } finally {
      setReactionConfigTransform(previousTransform);
    }

    for (const behavior of shape.behaviors) {
      if (!staticMembers.has(behavior)) {
        throw new Error(
          `[models] model does not implement required behavior "${behavior}" — return it from setup (§4.6)`,
        );
      }
    }
  } else {
    for (const [name, def] of shape.fields) {
      fields.set(name, { name, def });
    }
  }

  const definition: ModelDefinition = {
    [definitionBrand]: true,
    "~model": true,
    kind,
    name: config.name,
    fields,
    relations,
    inverses,
    behaviors: shape.behaviors,
    traits: shape.traits,
    fieldOrigins: shape.origins,
    staticMembers,
    setup: config.setup,
    locals: kind === "static" ? locals : undefined,
    create(props: Record<string, unknown>) {
      const boundCollection = (definition as { "~createInCollection"?: (p: unknown) => unknown })[
        "~createInCollection"
      ];

      if (!boundCollection) {
        throw new Error(
          "[models] Todo.create(props) is sugar over the active scope's collection — call collection(Model) first or use collection.add(props) (§6)",
        );
      }

      return boundCollection(props);
    },
  } as ModelDefinition;

  return definition;
}

function mergeMembers(
  members: Map<string, unknown>,
  returned: Record<string, unknown> | void,
  fields: ReadonlyMap<string, unknown>,
): void {
  if (!returned) return;

  for (const [name, member] of Object.entries(returned)) {
    if (RESERVED.has(name)) {
      throw new Error(
        `[models] setup returned "${name}" which collides with the instance/definition API (§4.6) — rename it`,
      );
    }

    if (fields.has(name)) {
      throw new Error(
        `[models] setup returned "${name}" which is already declared as a field — declarations may not collide (§4.6)`,
      );
    }

    if (members.has(name)) {
      throw new Error(
        `[models] two setups both provide "${name}" — exactly one participant may declare a member (§4.6)`,
      );
    }

    members.set(name, member);
  }
}

// The kernel keys scope state by an internal store id. We recover it through a
// probe scope: `seedScopeStoreValue` writes directly under that id without
// running the graph, so the probe is free of side effects.
function storeStateId(target: StoreWritable<unknown>): unknown {
  const probe: Scope = { values: new Map(), handlers: new Map(), deps: new Map() };

  seedScopeStoreValue(probe, target, undefined);

  const [id] = probe.values.keys();

  return id;
}

/** Dynamic instance: stores and units per instance, wrapped in an owner for cascade dispose. */
export function instantiateDynamic(
  definition: ModelDefinition,
  scope: Scope,
  values: ReadonlyMap<string, unknown>,
  props: Record<string, unknown>,
  internal: InstanceInternal,
): {
  stores: Map<string, StoreWritable<unknown>>;
  members: Map<string, unknown>;
  ownOwner: Owned<object>;
  ownerRef: Owner;
} {
  const stores = new Map<string, StoreWritable<unknown>>();
  const members = new Map<string, unknown>();
  let ownerRef!: Owner;
  let settingUp = true;

  const requireUnitBody = (operation: string): InstanceInternal => {
    if (settingUp) {
      throw new Error(
        `[models] self.${operation} needs an instance context — it is only available inside unit bodies, not in the setup body itself (§3.1)`,
      );
    }

    return internal;
  };

  const ownOwner = owner((_dispose, o) => {
    ownerRef = o;

    // The collection's scope is the instance's home (§3.4): setup and the units
    // it creates must not depend on whatever scope is ambient at add() time.
    return runScopeTask(scope, () => {
      for (const [name, runtime] of definition.fields) {
        stores.set(name, store<unknown>(runtime.def.defaultValue?.value));
      }

      for (const [name, runtime] of definition.relations) {
        stores.set(name, store<unknown>(relationDefault(runtime.def)));
      }

      // Values are seeded BEFORE setups run — setup reads see the input (§3.1).
      for (const [name, value] of values) {
        seedScopeStoreValue(scope, stores.get(name)!, value);
      }

      internal.ownStores = stores;
      internal.ownMembers = members;

      const self = new Proxy(Object.create(null), {
        get(_target, property) {
          if (typeof property !== "string") return undefined;

          if (
            definition.relations.has(property) ||
            definition.inverses.has(property)
          ) {
            const target = requireUnitBody(property);

            requireAlive(target);

            return target.relationView!(property);
          }

          const own = stores.get(property);

          if (own) return own;

          if (property === "id") return requireUnitBody("id").id;
          if (property === "key") return requireUnitBody("key").key;

          if (property === "alive") {
            const target = requireUnitBody("alive");

            target.onAliveRead?.();

            return target.alive;
          }

          if (property === "json") {
            return () => {
              const target = requireUnitBody("json()");

              requireAlive(target);

              return serializeInstance(target);
            };
          }

          if (property === "rebind") {
            return (newId: string) => {
              const target = requireUnitBody("rebind()");

              requireAlive(target);

              const oldId = target.id;

              if (oldId === newId) return;

              target.id = newId;
              target.temporaryId = false;
              target.onRebind?.(oldId, newId);
            };
          }

          if (property === "dispose") {
            return () => {
              requireUnitBody("dispose()").onDispose?.(internal);
            };
          }

          if (property === "onCleanup") {
            // Dynamic instances know themselves statically — usable right in
            // the setup body, alongside owner-attached subscriptions (§10.4).
            return (cleanup: () => void) => registerInstanceCleanup(internal, cleanup);
          }

          return members.get(property);
        },
      });

      const declaredNames = new Map<string, unknown>([
        ...definition.fields,
        ...definition.relations,
        ...definition.inverses,
      ]);

      for (const traitDef of definition.traits) {
        mergeMembers(members, traitDef.setup?.(self as never) ?? undefined, declaredNames);
      }

      const returned = definition.setup?.(self as never, props as never);

      mergeMembers(members, returned ?? undefined, declaredNames);

      for (const behavior of definition.behaviors) {
        if (!members.has(behavior)) {
          throw new Error(
            `[models] model does not implement required behavior "${behavior}" — return it from setup (§4.6)`,
          );
        }
      }

      settingUp = false;

      return {};
    });
  });

  return { stores, members, ownOwner, ownerRef };
}

interface TypedFnModelConfig<
  W extends readonly (TraitDef & AnyTraitTyped)[],
  S extends Record<string, unknown>,
  R extends ShapeRecord,
  M extends MembersRecord | void,
  ExtraSetupArgs extends readonly unknown[],
> {
  with?: W;
  data: (props: Props<S>) => R;
  setup?: (
    self: SelfOf<
      LocalizeUnbound<R> & TraitsShape<W>,
      TraitsMembers<W>,
      TraitsRequiredBehaviors<W>
    >,
    ...args: ExtraSetupArgs
  ) => M;
  name?: string;
}

interface TypedModelConfig<
  W extends readonly (TraitDef & AnyTraitTyped)[],
  R extends ShapeRecord,
  M extends MembersRecord | void,
  ExtraSetupArgs extends readonly unknown[],
> {
  with?: W;
  data?: R;
  setup?: (
    self: SelfOf<R & TraitsShape<W>, TraitsMembers<W>, TraitsRequiredBehaviors<W>>,
    ...args: ExtraSetupArgs
  ) => M;
  name?: string;
}

type TypedModelResult<
  W extends readonly (TraitDef & AnyTraitTyped)[],
  S extends Record<string, unknown>,
  R extends ShapeRecord,
  M extends MembersRecord | void,
> = ModelWithDescriptors<
  R & TraitsShape<W>,
  (M extends void ? {} : M) & TraitsMembers<W> & TraitsRequiredBehaviors<W>,
  S & TraitsProps<W>
>;

/** Экземпляр типизированной модели — экспортный алиас для аннотаций пользователей. */
export type InstanceOfModel<M> = M extends { "~shape"?: infer Sh; "~members"?: infer Mm }
  ? Sh extends ShapeRecord
    ? Mm extends MembersRecord
      ? Instance<Sh, Mm>
      : never
    : never
  : never;

export function model<
  const W extends readonly (TraitDef & AnyTraitTyped)[] = [],
  S extends Record<string, unknown> = {},
  R extends ShapeRecord = {},
  M extends MembersRecord | void = void,
>(
  config: TypedFnModelConfig<W, S, R, M, [props: Record<string, unknown>]>,
): TypedModelResult<W, S, LocalizeUnbound<R>, M>;
export function model<
  const W extends readonly (TraitDef & AnyTraitTyped)[] = [],
  R extends ShapeRecord = {},
  M extends MembersRecord | void = void,
>(
  config: TypedModelConfig<W, R, M, [props: Record<string, unknown>]>,
): TypedModelResult<W, {}, R, M>;
export function model(config: ModelConfig): ModelDefinition;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function model(config: any): any {
  return wrapDefinitionWithDescriptors(buildDefinition("dynamic", config));
}

export function staticModel<
  const W extends readonly (TraitDef & AnyTraitTyped)[] = [],
  S extends Record<string, unknown> = {},
  R extends ShapeRecord = {},
  M extends MembersRecord | void = void,
>(config: TypedFnModelConfig<W, S, R, M, []>): TypedModelResult<W, S, LocalizeUnbound<R>, M>;
export function staticModel<
  const W extends readonly (TraitDef & AnyTraitTyped)[] = [],
  R extends ShapeRecord = {},
  M extends MembersRecord | void = void,
>(config: TypedModelConfig<W, R, M, []>): TypedModelResult<W, {}, R, M>;
export function staticModel(config: ModelConfig): ModelDefinition;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function staticModel(config: any): any {
  return wrapDefinitionWithDescriptors(buildDefinition("static", config));
}

// ---------------------------------------------------------------------------
// Field descriptors on the definition (§8): `Todo.done` names the field for
// queries and sorting; the value surface lives on instances only.

export interface FieldDescriptor {
  readonly "~descriptor": true;
  readonly model: ModelDefinition;
  readonly field: string;
  eq(value: unknown): DescriptorPredicate;
  neq(value: unknown): DescriptorPredicate;
  gt(value: unknown): DescriptorPredicate;
  gte(value: unknown): DescriptorPredicate;
  lt(value: unknown): DescriptorPredicate;
  lte(value: unknown): DescriptorPredicate;
  between(from: unknown, to: unknown): DescriptorPredicate;
  startsWith(prefix: string): DescriptorPredicate;
  includes(part: unknown): DescriptorPredicate;
  readonly asc: DescriptorSort;
  readonly desc: DescriptorSort;
}

export interface DescriptorPredicate {
  readonly "~predicate": true;
  readonly model: ModelDefinition;
  readonly field: string;
  readonly op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between" | "startsWith" | "includes";
  readonly value: unknown;
  readonly upper?: unknown;
}

export interface DescriptorSort {
  readonly "~sort": true;
  readonly model: ModelDefinition;
  readonly field: string;
  readonly direction: "asc" | "desc";
}

function createDescriptor(definition: ModelDefinition, field: string): FieldDescriptor {
  const predicate = (
    op: DescriptorPredicate["op"],
    value: unknown,
    upper?: unknown,
  ): DescriptorPredicate => ({ "~predicate": true, model: definition, field, op, value, upper });

  return {
    "~descriptor": true,
    model: definition,
    field,
    eq: (value) => predicate("eq", value),
    neq: (value) => predicate("neq", value),
    gt: (value) => predicate("gt", value),
    gte: (value) => predicate("gte", value),
    lt: (value) => predicate("lt", value),
    lte: (value) => predicate("lte", value),
    between: (from, to) => predicate("between", from, to),
    startsWith: (prefix) => predicate("startsWith", prefix),
    includes: (part) => predicate("includes", part),
    asc: { "~sort": true, model: definition, field, direction: "asc" },
    desc: { "~sort": true, model: definition, field, direction: "desc" },
  };
}

function wrapDefinitionWithDescriptors(definition: ModelDefinition): ModelDefinition {
  const descriptors = new Map<string, FieldDescriptor>();

  const proxied = new Proxy(definition, {
    get(base, property, receiver) {
      if (
        typeof property === "string" &&
        !(property in base) &&
        (base.fields.has(property) || base.relations.has(property) || base.inverses.has(property))
      ) {
        let descriptor = descriptors.get(property);

        if (!descriptor) {
          descriptor = createDescriptor(receiver as ModelDefinition, property);
          descriptors.set(property, descriptor);
        }

        return descriptor;
      }

      return Reflect.get(base, property, receiver);
    },
  });

  (definition as unknown as { "~public"?: ModelDefinition })["~public"] = proxied;

  return proxied;
}

import * as virentia from "@virentia/core";
import {
  allSettled as effectorAllSettled,
  clearNode as clearEffectorNode,
  createEffect as createEffectorEffect,
  createEvent as createEffectorEvent,
  createNode as createEffectorNode,
  createWatch,
  is as effectorIs,
  launch,
  step as effectorStep,
} from "effector";
import type {
  Effect as EffectorEffect,
  EventCallable as EffectorEventCallable,
  Scope as EffectorScope,
  Subscription,
  Unit as EffectorUnit,
  UnitTargetable as EffectorUnitTargetable,
} from "effector";

export interface EffectorCompatibilityOptions {
  name?: string;
}

export interface EffectorAssociationConfig {
  virentia: virentia.Scope;
  effector: EffectorScope;
}

export interface EffectorAssociationLookup {
  virentia?: virentia.Scope;
  effector?: EffectorScope;
}

export type EffectorPayloadMap<From, To> = (payload: From) => To;

export type EffectorCompatibilityUnsubscribe = () => void;

export interface EffectorAssociation {
  dispose(): void;
}

export interface EffectorCompatibility {
  associate(config: EffectorAssociationConfig): EffectorAssociation;
  ensureAssociation(config?: EffectorAssociationLookup): EffectorAssociation;
  link<From, To = From>(
    from: EffectorUnit<From> | VirentiaUnit<From>,
    to: EffectorUnitTargetable<To> | VirentiaTarget<To>,
    map?: EffectorPayloadMap<From, To>,
  ): EffectorCompatibilityUnsubscribe;
  asEffector<T>(unit: virentia.Effect<T, any, any>): EffectorEffect<T, any, unknown>;
  asEffector<T>(unit: VirentiaUnit<T>): EffectorEventCallable<T>;
  asEffector<T>(unit: EffectorUnit<T>): EffectorUnit<T>;
  asVirentia<T>(unit: VirentiaUnit<T>): VirentiaUnit<T>;
  asVirentia<T>(unit: EffectorEffect<T, any, any>): virentia.Effect<T, any, unknown>;
  asVirentia<T>(unit: EffectorUnit<T>): virentia.EventCallable<T>;
}

export type VirentiaUnit<T = unknown> =
  | virentia.Event<T>
  | virentia.EventCallable<T>
  | virentia.Effect<T, any, any>
  | virentia.Store<T>
  | virentia.StoreWritable<T>;

export type VirentiaTarget<T = unknown> =
  | virentia.EventCallable<T>
  | virentia.Effect<T, any, any>
  | virentia.StoreWritable<T>;

type RuntimeInstaller = (runtime: EffectorRuntimeImpl) => EffectorCompatibilityUnsubscribe;

interface LinkDefinition<From = unknown, To = unknown> {
  from: EffectorUnit<From> | VirentiaUnit<From>;
  to: EffectorUnitTargetable<To> | VirentiaTarget<To>;
  map?: EffectorPayloadMap<From, To>;
}

export function createEffectorCompatibility(
  _options: EffectorCompatibilityOptions = {},
): EffectorCompatibility {
  const runtimes = new Set<EffectorRuntimeImpl>();
  const effectorByVirentia = new WeakMap<virentia.Scope, EffectorScope>();
  const virentiaByEffector = new WeakMap<EffectorScope, virentia.Scope>();
  const installers = new Set<RuntimeInstaller>();

  const compatibility: EffectorCompatibility = {
    associate,

    ensureAssociation(config = {}) {
      return ensureAssociation(config);
    },

    link(from, to, map) {
      const definition: LinkDefinition = {
        from: from as EffectorUnit<unknown> | VirentiaUnit<unknown>,
        to: to as EffectorUnitTargetable<unknown> | VirentiaTarget<unknown>,
        map: map as EffectorPayloadMap<unknown, unknown>,
      };
      const installer = (runtime: EffectorRuntimeImpl) => installLink(runtime, definition);

      return registerInstaller(installer);
    },

    asEffector: ((unit: EffectorUnit<unknown> | VirentiaUnit<unknown>) =>
      createEffectorAdapter(unit)) as EffectorCompatibility["asEffector"],

    asVirentia: ((unit: EffectorUnit<unknown> | VirentiaUnit<unknown>) =>
      createVirentiaAdapter(unit)) as EffectorCompatibility["asVirentia"],
  };

  return compatibility;

  function associate(config: EffectorAssociationConfig): EffectorAssociation {
    if (!config.virentia) {
      throw new Error(
        "Effector compatibility association requires a Virentia scope",
      );
    }

    if (!config.effector) {
      throw new Error(
        "Effector compatibility association requires an Effector scope",
      );
    }

    assertScopesAvailable(config);

    const existing = findRuntime(config);

    if (existing) {
      existing.assertSamePair(config);
      return existing;
    }

    const runtime = new EffectorRuntimeImpl({
      ...config,
      release: () => {
        runtimes.delete(runtime);
        effectorByVirentia.delete(config.virentia);
        virentiaByEffector.delete(config.effector);

      },
    });

    runtimes.add(runtime);
    effectorByVirentia.set(config.virentia, config.effector);
    virentiaByEffector.set(config.effector, config.virentia);

    for (const installer of installers) {
      runtime.addInstaller(installer);
    }

    return runtime;
  }

  function assertScopesAvailable(config: EffectorAssociationConfig): void {
    const existingEffector = effectorByVirentia.get(config.virentia);

    if (existingEffector && existingEffector !== config.effector) {
      throw new Error("Virentia scope is already associated with another Effector scope");
    }

    const existingVirentia = virentiaByEffector.get(config.effector);

    if (existingVirentia && existingVirentia !== config.virentia) {
      throw new Error("Effector scope is already associated with another Virentia scope");
    }
  }

  function ensureAssociation(config: EffectorAssociationLookup = {}): EffectorRuntimeImpl {
    const runtime = findRuntime(config);

    if (!runtime) {
      throw createMissingRuntimeError(config);
    }

    return runtime;
  }

  function findRuntime(config: EffectorAssociationLookup = {}): EffectorRuntimeImpl | null {
    if (config.virentia) {
      const effectorScope = effectorByVirentia.get(config.virentia);
      const runtime = effectorScope
        ? findRuntimeByPair(config.virentia, effectorScope)
        : null;

      if (runtime) return runtime;
    }

    if (config.effector) {
      const virentiaScope = virentiaByEffector.get(config.effector);
      const runtime = virentiaScope
        ? findRuntimeByPair(virentiaScope, config.effector)
        : null;

      if (runtime) return runtime;
    }

    return null;
  }

  function findRuntimeByPair(
    virentiaScope: virentia.Scope,
    effectorScope: EffectorScope,
  ): EffectorRuntimeImpl | null {
    for (const runtime of runtimes) {
      if (runtime.virentia === virentiaScope && runtime.effector === effectorScope) {
        return runtime;
      }
    }

    return null;
  }

  function registerInstaller(installer: RuntimeInstaller): EffectorCompatibilityUnsubscribe {
    installers.add(installer);

    for (const runtime of runtimes) {
      runtime.addInstaller(installer);
    }

    return () => {
      installers.delete(installer);

      for (const runtime of runtimes) {
        runtime.removeInstaller(installer);
      }
    };
  }

  function createEffectorAdapter(
    unit: EffectorUnit<unknown> | VirentiaUnit<unknown>,
  ): EffectorUnit<unknown> {
    if (isEffectorUnit(unit)) {
      return unit;
    }

    if (isVirentiaEffect(unit)) {
      const scopeQueue: Array<EffectorScope | null | undefined> = [];
      const adapter = createEffectorEffect((payload: unknown) => {
        const runtime = resolveRuntimeFromEffectorScope(scopeQueue.shift());

        return runtime.call(unit, payload as never);
      }) as EffectorEffect<unknown, unknown, unknown>;

      createEffectorScopeNode(adapter, (_payload, scope) => {
        scopeQueue.push(scope);
      });

      return adapter;
    }

    const adapter = createEffectorEvent<unknown>();
    createEffectorScopeNode(adapter, (payload, scope) => {
      const runtime = resolveRuntimeFromEffectorScope(scope);

      if (runtime.shouldSkipEffector(adapter)) return;

      runtime.emitVirentia(unit as VirentiaTarget<unknown>, payload, {
        suppressReaction: true,
      });
    });

    registerInstaller((runtime) =>
      installLink(runtime, {
        from: unit as VirentiaUnit<unknown>,
        to: adapter,
      }),
    );

    return adapter;
  }

  function createVirentiaAdapter(
    unit: EffectorUnit<unknown> | VirentiaUnit<unknown>,
  ): VirentiaUnit<unknown> {
    if (isVirentiaUnit(unit)) {
      return unit as VirentiaUnit<unknown>;
    }

    if (effectorIs.effect(unit)) {
      return virentia.effect((payload: unknown) => {
        const runtime = resolveRuntimeFromVirentiaScope();

        return runtime.call(unit as EffectorEffect<unknown, unknown, unknown>, payload as never);
      });
    }

    const adapter = virentia.event<unknown>();
    createEffectorScopeNode(unit, (payload, scope) => {
      const runtime = resolveRuntimeFromEffectorScope(scope);

      if (runtime.shouldSkipEffector(unit as object)) return;

      runtime.emitVirentia(adapter, payload, {
        suppressReaction: true,
      });
    });

    registerInstaller((runtime) =>
      installLink(runtime, {
        from: adapter,
        to: unit as EffectorUnitTargetable<unknown>,
      }),
    );

    return adapter;
  }

  function resolveRuntimeFromEffectorScope(
    scope: EffectorScope | null | undefined,
  ): EffectorRuntimeImpl {
    if (!scope) {
      throw createMissingRuntimeError({});
    }

    const runtime = ensureAssociation({ effector: scope });
    const activeVirentiaScope = virentia.getCurrentScope();

    if (activeVirentiaScope && activeVirentiaScope !== runtime.virentia) {
      throw new Error("Effector scope is associated with another Virentia scope");
    }

    return runtime;
  }

  function resolveRuntimeFromVirentiaScope(): EffectorRuntimeImpl {
    const activeVirentiaScope = virentia.getCurrentScope();

    if (!activeVirentiaScope) {
      throw createMissingRuntimeError({});
    }

    return ensureAssociation({ virentia: activeVirentiaScope });
  }
}

interface RuntimeConfig extends EffectorAssociationConfig {
  release(): void;
}

class EffectorRuntimeImpl implements EffectorAssociation {
  readonly virentia: virentia.Scope;
  readonly effector: EffectorScope;

  private disposed = false;
  private readonly cleanups = new Set<EffectorCompatibilityUnsubscribe>();
  private readonly cleanupByInstaller = new Map<RuntimeInstaller, EffectorCompatibilityUnsubscribe>();
  private readonly releaseAssociation: () => void;
  private readonly suppressedEffector = new Map<object, number>();
  private readonly suppressedVirentia = new Map<object, number>();

  constructor(config: RuntimeConfig) {
    this.virentia = config.virentia;
    this.effector = config.effector;
    this.releaseAssociation = config.release;
  }

  async call<T>(unit: EffectorUnitTargetable<T> | VirentiaTarget<T>, payload: T): Promise<unknown> {
    this.assertAlive();

    if (isEffectorUnit(unit)) {
      return effectorAllSettled(unit, {
        params: payload,
        scope: this.effector,
      } as never);
    }

    if (isVirentiaEffect(unit)) {
      return virentia.scoped(this.virentia, () => unit(payload as never));
    }

    await virentia.allSettled(unit as VirentiaTarget<T>, {
      payload,
      scope: this.virentia,
    });
  }

  trackCleanup(unsubscribe: EffectorCompatibilityUnsubscribe): EffectorCompatibilityUnsubscribe {
    this.cleanups.add(unsubscribe);

    return () => {
      this.cleanups.delete(unsubscribe);
      unsubscribe();
    };
  }

  dispose(): void {
    if (this.disposed) return;

    this.disposed = true;

    for (const cleanup of [...this.cleanups]) {
      cleanup();
    }

    this.cleanups.clear();
    this.cleanupByInstaller.clear();
    this.releaseAssociation();
  }

  addInstaller(installer: RuntimeInstaller): void {
    if (this.disposed || this.cleanupByInstaller.has(installer)) return;

    const cleanup = installer(this);
    this.cleanupByInstaller.set(installer, cleanup);
    this.cleanups.add(cleanup);
  }

  removeInstaller(installer: RuntimeInstaller): void {
    const cleanup = this.cleanupByInstaller.get(installer);

    if (!cleanup) return;

    this.cleanupByInstaller.delete(installer);
    this.cleanups.delete(cleanup);
    cleanup();
  }

  assertSamePair(config: EffectorAssociationConfig): void {
    if (config.virentia !== this.virentia || config.effector !== this.effector) {
      throw new Error("Effector compatibility association is already bound to another scope pair");
    }
  }

  launchEffector<T>(
    unit: EffectorUnitTargetable<T>,
    payload: T,
    options: { suppressWatch?: boolean } = {},
  ): void {
    this.assertAlive();

    if (options.suppressWatch) {
      this.incrementSuppression(this.suppressedEffector, unit);
    }

    try {
      launch({
        target: unit,
        params: payload,
        scope: this.effector,
      });
    } finally {
      if (options.suppressWatch) {
        this.decrementSuppression(this.suppressedEffector, unit);
      }
    }
  }

  emitVirentia<T>(
    unit: VirentiaTarget<T>,
    payload: T,
    options: { suppressReaction?: boolean } = {},
  ): void {
    this.assertAlive();

    if (options.suppressReaction) {
      this.incrementSuppression(this.suppressedVirentia, unit);
    }

    const settled = virentia.allSettled(unit, {
      payload,
      scope: this.virentia,
    });

    if (options.suppressReaction) {
      void settled.finally(() => {
        this.decrementSuppression(this.suppressedVirentia, unit);
      });
    }
  }

  shouldSkipEffector(unit: object): boolean {
    return (this.suppressedEffector.get(unit) ?? 0) > 0;
  }

  shouldSkipVirentia(unit: object): boolean {
    return (this.suppressedVirentia.get(unit) ?? 0) > 0;
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error("Effector compatibility association is disposed");
    }
  }

  private incrementSuppression(map: Map<object, number>, unit: object): void {
    map.set(unit, (map.get(unit) ?? 0) + 1);
  }

  private decrementSuppression(map: Map<object, number>, unit: object): void {
    const next = (map.get(unit) ?? 0) - 1;

    if (next <= 0) {
      map.delete(unit);
    } else {
      map.set(unit, next);
    }
  }
}

function createEffectorScopeNode<T>(
  unit: EffectorUnit<T>,
  fn: (payload: T, scope: EffectorScope | null | undefined) => void,
): EffectorCompatibilityUnsubscribe {
  const node = createEffectorNode({
    parent: [unit] as any,
    node: [
      ...(effectorIs.store(unit)
        ? [
            effectorStep.mov({
              store: (unit as any).stateRef,
              to: "stack",
            }),
          ]
        : []),
      effectorStep.run({
        fn(payload: T, _local: unknown, stack: { scope?: EffectorScope | null }) {
          fn(payload, stack.scope);
        },
      }),
    ],
    family: {
      owners: [unit],
    },
  });

  return () => {
    clearEffectorNode(node);
  };
}

function installLink(runtime: EffectorRuntimeImpl, definition: LinkDefinition): EffectorCompatibilityUnsubscribe {
  const map = definition.map ?? identity;

  if (isEffectorUnit(definition.from)) {
    const subscription = createWatch({
      unit: definition.from,
      scope: runtime.effector,
      fn(payload) {
        if (runtime.shouldSkipEffector(definition.from as object)) return;

        const nextPayload = map(payload);

        if (isEffectorUnit(definition.to)) {
          runtime.launchEffector(definition.to as EffectorUnitTargetable<unknown>, nextPayload);
          return;
        }

        runtime.emitVirentia(definition.to as VirentiaTarget<unknown>, nextPayload, {
          suppressReaction: true,
        });
      },
    });

    return toUnsubscribe(subscription);
  }

  if (isVirentiaUnit(definition.from)) {
    const watcher = virentia.reaction({
      on: definition.from as virentia.Event<unknown>,
      scope: runtime.virentia,
      run(payload) {
        if (runtime.shouldSkipVirentia(definition.from as object)) return;

        const nextPayload = map(payload);

        if (isEffectorUnit(definition.to)) {
          runtime.launchEffector(definition.to as EffectorUnitTargetable<unknown>, nextPayload, {
            suppressWatch: true,
          });
          return;
        }

        runtime.emitVirentia(definition.to as VirentiaTarget<unknown>, nextPayload);
      },
    });

    return () => {
      watcher.stop();
    };
  }

  throw new Error("Effector compatibility link expects Effector or Virentia units");
}

function createMissingRuntimeError(config: EffectorAssociationLookup): Error {
  if (config.effector) {
    return new Error("Effector compatibility association is missing for provided Effector scope");
  }

  if (config.virentia) {
    return new Error("Effector compatibility association is missing for provided Virentia scope");
  }

  return new Error(
    "Effector compatibility association is missing. Call associate({ virentia, effector }) before using adapters.",
  );
}

function isEffectorUnit(value: unknown): value is EffectorUnit<any> {
  return effectorIs.unit(value as any);
}

function isVirentiaUnit(value: unknown): value is VirentiaUnit<any> {
  return Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      "node" in value &&
      !isEffectorUnit(value),
  );
}

function isVirentiaEffect(value: unknown): value is virentia.Effect<any, any, any> {
  return Boolean(isVirentiaUnit(value) && "doneData" in value && "$pending" in value);
}

function toUnsubscribe(subscription: Subscription): EffectorCompatibilityUnsubscribe {
  return () => {
    subscription.unsubscribe();
  };
}

function identity<T>(value: T): T {
  return value;
}

import { Value } from "@sinclair/typebox/value";
import { withoutOwner, owner } from "../graph/owner";
import { withNodeScopeResolver } from "../kernel/create";
import { requireActiveScope, runScopeFrame } from "../scope/internal";
import { withSidScope } from "../scope/snapshot";
import type { Scope } from "../scope/types";
import { collection, normalizeHomeScope, stateOfCollection } from "./collection";
import { modelSingletonBinding } from "./bindings";
import {
  createInstanceFacade,
  createSingletonDefinition,
  instanceInternalOf,
  type InstanceInternal,
  type ModelDefinition,
} from "./definition";
import { fieldIn } from "./fields";

// Only declaration ordinals are shared, never model objects or unit graphs.
const declarations = new WeakMap<ModelDefinition, number>();
let anonymousAddress = 0;

/** @internal Same description, independent native graph, ordinary per-scope store values. */
export function createSingleton(
  source: ModelDefinition,
  input: Record<string, unknown> | undefined,
  bind: (definition: ModelDefinition) => ModelDefinition,
): object {
  const props = { ...input };
  const values = new Map<string, unknown>();
  for (const [name, runtime] of source.fields) {
    const def = runtime.def;
    const key = def.binding.key === false ? null : (def.binding.key ?? name);
    if (key !== null && key in props) {
      if (
        !def.binding.in &&
        !(props[key] === null && def.optionalValue) &&
        !Value.Check(def.schema, props[key])
      ) {
        throw new TypeError(`[models] Model.static(): invalid constructor field "${key}"`);
      }
      values.set(name, fieldIn(def, props[key]));
    } else if (def.defaultValue) values.set(name, def.defaultValue.value);
    else if (key !== null)
      throw new Error(`[models] Model.static() requires constructor field "${key}"`);
    else values.set(name, undefined);
  }
  let definition!: ModelDefinition;
  let declaring = true;
  const initializing = new WeakSet<Scope>();
  const current = (scope = requireActiveScope(() => "access a model singleton")): object => {
    if (declaring)
      throw new Error("[models] Singleton setup runs once; access instance identity and resources in onCreate or unit bodies");
    const home = normalizeHomeScope(scope);
    return runScopeFrame(home, () => {
      const instances = collection(definition, home);
      const state = stateOfCollection(instances);
      const internal = state.rows.values().next().value;
      if (internal) {
        let facade = internal.facade;
        if (!facade) {
          facade = createInstanceFacade(internal);
          internal.facade = facade;
        }
        return facade;
      }
      if (initializing.has(home)) throw new Error("[models] Recursive singleton initialization");
      initializing.add(home);
      try {
        return instances.add({ ...props, id: "$static" });
      } finally {
        initializing.delete(home);
      }
    });
  };
  const resolveScope = (scope: Scope): Scope => {
    if (declaring) return scope;
    const home = normalizeHomeScope(scope);
    if (!initializing.has(home)) current(home);
    return home;
  };
  const declaration = (declarations.get(source) ?? 0) + 1;
  declarations.set(source, declaration);
  const address = `singleton:${source.sid ?? source.name ?? `anonymous:${++anonymousAddress}`}/static:${declaration}`;
  // A module-level graph must not inherit the component/instance that asked for it.
  const graph = withoutOwner(() =>
    owner(() => ({
      definition: withNodeScopeResolver(resolveScope, () =>
        withSidScope(address, () =>
          runScopeFrame({ values: new Map(), handlers: new Map(), deps: new Map() }, () =>
            bind(
              createSingletonDefinition(
                source,
                declaration,
                props,
                values,
                () => instanceInternalOf(current()) as InstanceInternal,
              ),
            ),
          ),
        ),
      ),
    })),
  );
  definition = graph.definition;
  declaring = false;
  const target = Object.create(null) as Record<PropertyKey, unknown>;
  for (const [name, runtime] of definition.fields) target[name] = runtime.staticStore;
  for (const [name, member] of definition.staticMembers ?? []) target[name] = member;
  for (const name of [...definition.relations.keys(), ...definition.inverses.keys()]) {
    Object.defineProperty(target, name, {
      enumerable: true,
      get: () => Reflect.get(current(), name),
    });
  }
  Object.defineProperties(target, {
    [modelSingletonBinding]: { value: { resolve: current } },
    id: { get: () => Reflect.get(current(), "id") },
    key: { get: () => Reflect.get(current(), "key") },
    alive: { get: () => Reflect.get(current(), "alive") },
    json: { value: () => Reflect.get(current(), "json")() },
    toJSON: { value: () => Reflect.get(current(), "json")() },
    rebind: { value: (id: string) => Reflect.get(current(), "rebind")(id) },
    onCleanup: { value: (cleanup: () => void) => Reflect.get(current(), "onCleanup")(cleanup) },
    dispose: {
      value: () => {
        const scope = normalizeHomeScope(requireActiveScope(() => "dispose a model singleton"));
        const instance = collection(definition, scope).first as {
          dispose(): void | Promise<void>;
        } | null;
        return instance?.dispose();
      },
    },
  });
  return Object.freeze(target);
}

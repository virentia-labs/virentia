import { withUnitDeclarationTracker } from "../graph/declaration";
import { markStoreTransient, withStoreDeclarationTracker } from "../scope/snapshot";
import type { Scope } from "../scope/types";
import {
  nativeStoreStateOf,
  readNativeStoreState,
  store,
  type NativeStoreState,
  type StoreWritable,
} from "../units/store";
import type { Node } from "../kernel/types";

export interface RegistryStore<T> {
  readonly unit: StoreWritable<T | undefined>;
  readonly state: NativeStoreState;
  readonly node: Node;
}

/** One declaration, independent registry state in each application scope. */
export function registryStore<T>(): RegistryStore<T> {
  const unit = withUnitDeclarationTracker(null, () =>
    withStoreDeclarationTracker(
      () => {},
      () => store<T | undefined>(undefined),
    ),
  );
  markStoreTransient(unit);
  return { unit, state: nativeStoreStateOf(unit)!, node: unit.node };
}

/** Registry materialization is infrastructure, not a reactive dependency. */
export function readRegistry<T>(registry: RegistryStore<T>, scope: Scope): T | undefined {
  return readNativeStoreState(registry.node.resolveScope?.(scope) ?? scope, registry.state) as
    | T
    | undefined;
}

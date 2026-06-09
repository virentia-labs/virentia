import * as virentia from "@virentia/core";
import type { Scope as EffectorScope } from "effector";

export interface EffectorAssociationConfig {
  virentia: virentia.Scope;
  effector: EffectorScope;
}

export interface EffectorAssociationLookup {
  virentia?: virentia.Scope;
  effector?: EffectorScope;
}

export interface EffectorAssociation {
  readonly virentia: virentia.Scope;
  readonly effector: EffectorScope;
}

export interface EffectorAssociations {
  readonly byVirentia: WeakMap<virentia.Scope, EffectorAssociation>;
  readonly byEffector: WeakMap<EffectorScope, EffectorAssociation>;
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

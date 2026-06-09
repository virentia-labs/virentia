import * as virentia from "@virentia/core";
import {
  createEffect as createEffectorEffect,
  createEvent as createEffectorEvent,
  is as effectorIs,
} from "effector";
import type {
  Effect as EffectorEffect,
  EventCallable as EffectorEventCallable,
  Unit as EffectorUnit,
  UnitTargetable as EffectorUnitTargetable,
  Scope as EffectorScope,
} from "effector";
import { shouldSkipEffector } from "./association-state";
import { isEffectorUnit, isObjectLike, isVirentiaEffect, isVirentiaUnit } from "./guards";
import type { BridgeUnit } from "./internal-types";
import {
  callAssociation,
  createEffectorScopeNode,
  emitVirentia,
  installVirentiaToEffectorLink,
  resolveAssociationFromEffectorScope,
  resolveAssociationFromVirentiaScope,
} from "./runtime";
import type { VirentiaTarget, VirentiaUnit } from "./types";

type AnyCall = (...args: any[]) => unknown;

const fooledUnit = Symbol("virentia.effector.fooledUnit");
const fooledUnits = new WeakMap<object, object>();

export function fool<Params, Done, Fail>(
  unit: virentia.Effect<Params, Done, Fail>,
): virentia.Effect<Params, Done, Fail> & EffectorEffect<Params, Done, Fail>;
export function fool<T>(
  unit: virentia.EventCallable<T>,
): virentia.EventCallable<T> & EffectorEventCallable<T>;
export function fool<T>(unit: virentia.Event<T>): virentia.Event<T> & EffectorEventCallable<T>;
export function fool<T>(
  unit: virentia.StoreWritable<T>,
): virentia.StoreWritable<T> & EffectorEventCallable<T>;
export function fool<T>(unit: virentia.Store<T>): virentia.Store<T> & EffectorEventCallable<T>;
export function fool<Params, Done, Fail>(
  unit: EffectorEffect<Params, Done, Fail>,
): EffectorEffect<Params, Done, Fail> & virentia.Effect<Params, Done, Fail>;
export function fool<T>(
  unit: EffectorEventCallable<T>,
): EffectorEventCallable<T> & virentia.EventCallable<T>;
export function fool<T>(
  unit: EffectorUnitTargetable<T>,
): EffectorUnitTargetable<T> & virentia.EventCallable<T>;
export function fool<T>(unit: EffectorUnit<T>): EffectorUnit<T> & virentia.EventCallable<T>;
export function fool(unit: BridgeUnit): BridgeUnit {
  if (!isObjectLike(unit)) {
    throw new Error("fool() expects an Effector or Virentia unit");
  }

  if ((unit as { [fooledUnit]?: true })[fooledUnit]) {
    return unit;
  }

  const cached = fooledUnits.get(unit);

  if (cached) {
    return cached as BridgeUnit;
  }

  const fooled = isEffectorUnit(unit)
    ? createFooledEffectorUnit(unit)
    : isVirentiaUnit(unit)
      ? createFooledVirentiaUnit(unit as VirentiaUnit)
      : null;

  if (!fooled) {
    throw new Error("fool() expects an Effector or Virentia unit");
  }

  markFooledUnit(fooled);
  fooledUnits.set(unit, fooled);

  return fooled;
}

function createFooledVirentiaUnit(unit: VirentiaUnit): BridgeUnit {
  const effectorUnit = createEffectorAdapter(unit);
  const base =
    typeof unit === "function" ? createCallableBridge((...args) => (unit as AnyCall)(...args)) : {};

  copyUnitProperties(base, effectorUnit);
  copyUnitProperties(base, unit);

  return base as BridgeUnit;
}

function createFooledEffectorUnit(unit: EffectorUnit<unknown>): BridgeUnit {
  const virentiaUnit = createVirentiaAdapter(unit);
  const base =
    typeof unit === "function" || typeof virentiaUnit === "function"
      ? createCallableBridge((...args) => {
          if (virentia.getCurrentScope() && typeof virentiaUnit === "function") {
            return (virentiaUnit as AnyCall)(...args);
          }

          if (typeof unit === "function") {
            return (unit as AnyCall)(...args);
          }

          throw new Error("Effector store cannot be called");
        })
      : {};

  copyUnitProperties(base, virentiaUnit);
  copyUnitProperties(base, unit);

  return base as BridgeUnit;
}

function createCallableBridge(call: AnyCall): AnyCall {
  return (...args: any[]) => call(...args);
}

function createEffectorAdapter(unit: BridgeUnit): EffectorUnit<unknown> {
  if (isEffectorUnit(unit)) {
    return unit;
  }

  if (isVirentiaEffect(unit)) {
    const scopeQueue: Array<EffectorScope | null | undefined> = [];
    const adapter = createEffectorEffect((payload: unknown) => {
      const association = resolveAssociationFromEffectorScope(scopeQueue.shift());

      return callAssociation(association, unit, payload);
    }) as EffectorEffect<unknown, unknown, unknown>;

    createEffectorScopeNode(adapter, (_payload, scope) => {
      scopeQueue.push(scope);
    });

    return adapter;
  }

  const adapter = createEffectorEvent<unknown>();

  createEffectorScopeNode(adapter, (payload, scope) => {
    const association = resolveAssociationFromEffectorScope(scope);

    if (shouldSkipEffector(association, adapter)) return;

    emitVirentia(association, unit as VirentiaTarget<unknown>, payload, {
      suppressReaction: true,
    });
  });

  installVirentiaToEffectorLink(unit, adapter);

  return adapter;
}

function createVirentiaAdapter(unit: BridgeUnit): VirentiaUnit {
  if (isVirentiaUnit(unit)) {
    return unit as VirentiaUnit;
  }

  if (effectorIs.effect(unit)) {
    return virentia.effect((payload: unknown) => {
      const association = resolveAssociationFromVirentiaScope();

      return callAssociation(
        association,
        unit as EffectorEffect<unknown, unknown, unknown>,
        payload,
      );
    });
  }

  const adapter = virentia.event<unknown>();

  createEffectorScopeNode(unit, (payload, scope) => {
    const association = resolveAssociationFromEffectorScope(scope);

    if (shouldSkipEffector(association, unit as object)) return;

    emitVirentia(association, adapter, payload, {
      suppressReaction: true,
    });
  });

  installVirentiaToEffectorLink(adapter, unit as EffectorUnitTargetable<unknown>);

  return adapter;
}

function copyUnitProperties(target: object, source: object): void {
  for (const key of Reflect.ownKeys(source)) {
    if (key === "length" || key === "name" || key === "prototype") continue;

    const descriptor = Object.getOwnPropertyDescriptor(source, key);

    if (!descriptor) continue;

    const existing = Object.getOwnPropertyDescriptor(target, key);

    if (existing && !existing.configurable) continue;

    Object.defineProperty(target, key, descriptor);
  }
}

function markFooledUnit(unit: object): void {
  Object.defineProperty(unit, fooledUnit, {
    enumerable: false,
    value: true,
  });
}

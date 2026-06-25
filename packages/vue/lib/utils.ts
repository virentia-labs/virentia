import {
  run,
  scoped,
  type Effect,
  type EventCallable,
  type ReactiveWritable,
  type Scope,
  type StoreWritable,
} from "@virentia/core";
import type { Component } from "vue";
import type { AnyStore, UnitLike } from "./types";

export function readStore<T>(unit: AnyStore<T>, scope: Scope): T {
  return scoped(scope, () => {
    const keys = Reflect.ownKeys(unit).filter((key) => !nativeStoreKeys.has(key));

    if (keys.length === 1 && keys[0] === "value") {
      return Reflect.get(unit, "value") as T;
    }

    if (isArraySnapshot(unit, keys)) {
      const length = Reflect.get(unit, "length") as number;

      return Array.from({ length }, (_value, index) => Reflect.get(unit, String(index))) as T;
    }

    return Object.fromEntries(keys.map((key) => [key, Reflect.get(unit, key)])) as T;
  });
}

export function writeStore<T>(
  unit: StoreWritable<T> | ReactiveWritable<T>,
  value: T,
  scope: Scope,
): void {
  void run({
    unit: unit.node,
    payload: value,
    scope,
  });
}

export function isUnitLike(value: unknown): value is UnitLike {
  return isStoreUnit(value) || isCallableUnit(value);
}

export function isStoreUnit(value: unknown): value is AnyStore {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    "node" in value &&
    "subscribe" in value &&
    typeof (value as { subscribe?: unknown }).subscribe === "function",
  );
}

export function isCallableUnit(
  value: unknown,
): value is EventCallable<any> | Effect<any, any, any> {
  return Boolean(typeof value === "function" && "node" in value);
}

export function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

export function getComponentName(view: Component): string {
  const named = view as { name?: string; __name?: string };

  return `Virentia(${named.name ?? named.__name ?? "Component"})`;
}

function isArraySnapshot(unit: AnyStore, keys: readonly PropertyKey[]): boolean {
  return (
    keys.includes("length") &&
    keys.every(
      (key) => key === "length" || (typeof key === "string" && arrayIndexPattern.test(key)),
    ) &&
    typeof Reflect.get(unit, "length") === "number"
  );
}

const arrayIndexPattern = /^(0|[1-9]\d*)$/;
const nativeStoreKeys = new Set<PropertyKey>([
  "node",
  "writable",
  "subscribe",
  "map",
  "filter",
  "filterMap",
]);

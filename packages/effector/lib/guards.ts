import * as virentia from "@virentia/core";
import { is as effectorIs } from "effector";
import type { Unit as EffectorUnit } from "effector";
import type { VirentiaUnit } from "./types";

export function isEffectorUnit(value: unknown): value is EffectorUnit<any> {
  return effectorIs.unit(value as any);
}

export function isVirentiaUnit(value: unknown): value is VirentiaUnit<any> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    "node" in value &&
    !isEffectorUnit(value),
  );
}

export function isVirentiaEffect(value: unknown): value is virentia.Effect<any, any, any> {
  return Boolean(isVirentiaUnit(value) && "doneData" in value && "$pending" in value);
}

export function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

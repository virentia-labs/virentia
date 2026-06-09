import type { Unit as EffectorUnit, UnitTargetable as EffectorUnitTargetable } from "effector";
import type { VirentiaTarget, VirentiaUnit } from "./types";

export type BridgeUnit<T = any> = EffectorUnit<T> | EffectorUnitTargetable<T> | VirentiaUnit<T>;

export type BridgeTarget<T = unknown> = EffectorUnitTargetable<T> | VirentiaTarget<T>;

export type BridgeCleanup = () => void;

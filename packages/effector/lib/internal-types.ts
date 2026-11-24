import type { Unit as EffectorUnit, UnitTargetable as EffectorUnitTargetable } from "effector";
import type { VirentiaFieldStore, VirentiaTarget, VirentiaUnit } from "./types";

export type VirentiaBridgeUnit<T = unknown> = VirentiaUnit<T> | VirentiaFieldStore<T>;
export type VirentiaBridgeTarget<T = unknown> = VirentiaTarget<T> | VirentiaFieldStore<T>;

export type BridgeUnit<T = any> = EffectorUnit<T> | EffectorUnitTargetable<T> | VirentiaBridgeUnit<T>;

export type BridgeTarget<T = unknown> = EffectorUnitTargetable<T> | VirentiaBridgeTarget<T>;

export type BridgeCleanup = () => void;

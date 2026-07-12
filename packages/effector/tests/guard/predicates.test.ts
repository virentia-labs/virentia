import { afterEach, describe, expect, it } from "vitest";
import { createEffect, createEvent, createStore } from "effector";
import { effect, event, store } from "@virentia/core";
import {
  isEffectorUnit,
  isObjectLike,
  isVirentiaEffect,
  isVirentiaUnit,
} from "../../lib/guards";
import { resetAmbientScope } from "../support/effector-harness";

afterEach(resetAmbientScope);

describe("guard predicates", () => {
  it("isEffectorUnit discriminates effector units from virentia and plain values", () => {
    expect(isEffectorUnit(createEvent())).toBe(true);
    expect(isEffectorUnit(createStore(0))).toBe(true);
    expect(isEffectorUnit(createEffect(async () => 1))).toBe(true);
    expect(isEffectorUnit(event())).toBe(false);
    expect(isEffectorUnit(store(0))).toBe(false);
    expect(isEffectorUnit(42)).toBe(false);
    expect(isEffectorUnit(null)).toBe(false);
  });

  it("isVirentiaUnit requires a node and a non-effector identity", () => {
    expect(isVirentiaUnit(event())).toBe(true);
    expect(isVirentiaUnit(store(0))).toBe(true);
    expect(isVirentiaUnit({ node: {} })).toBe(true);
    expect(isVirentiaUnit(createEvent())).toBe(false);
    expect(isVirentiaUnit({})).toBe(false);
    expect(isVirentiaUnit(null)).toBe(false);
  });

  it("isVirentiaEffect requires doneData and pending", () => {
    expect(isVirentiaEffect(effect(async () => 1))).toBe(true);
    expect(isVirentiaEffect(event())).toBe(false);
    expect(isVirentiaEffect(store(0))).toBe(false);
    expect(isVirentiaEffect(createEffect(async () => 1))).toBe(false);
  });

  it("isObjectLike distinguishes objects and functions from primitives", () => {
    expect(isObjectLike(null)).toBe(false);
    expect(isObjectLike(undefined)).toBe(false);
    expect(isObjectLike("s")).toBe(false);
    expect(isObjectLike(0)).toBe(false);
    expect(isObjectLike({})).toBe(true);
    expect(isObjectLike(() => {})).toBe(true);
  });
});

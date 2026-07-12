import { afterEach, describe, expect, it } from "vitest";
import { createEvent } from "effector";
import { event } from "@virentia/core";
import { isEffectorUnit, isVirentiaUnit } from "../../lib/guards";
import { fool } from "../../lib";
import { resetAmbientScope } from "../support/effector-harness";

afterEach(resetAmbientScope);

describe("guards over a fooled unit", () => {
  it("reads a fooled unit as an effector unit while isVirentiaUnit stays false", () => {
    // NOTE: isVirentiaUnit explicitly returns `!isEffectorUnit(value)`, so a fooled
    // unit (which effector's `is.unit` recognises) is NOT reported as a virentia unit
    // by this guard. The "dual identity" only holds via effector's own `is` + the
    // raw `.node` property the runtime reads directly. See suspected-bug note.
    const fe = fool(createEvent<number>());
    expect(isEffectorUnit(fe)).toBe(true);
    expect(isVirentiaUnit(fe)).toBe(false);
    expect("node" in (fe as object)).toBe(true);

    const fv = fool(event<number>());
    expect(isEffectorUnit(fv)).toBe(true);
    expect(isVirentiaUnit(fv)).toBe(false);
    expect("node" in (fv as object)).toBe(true);
  });
});

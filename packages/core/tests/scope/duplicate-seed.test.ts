import { afterEach, describe, expect, it } from "vitest";
import { dependency, effect, scope, scoped, store } from "../../lib";
import { resetActiveScope } from "../support/scope-helpers";

afterEach(resetActiveScope);

describe("scope() with a duplicated seed", () => {
  it("keeps the last value when the same store is seeded twice", () => {
    const st = store(0);
    const s = scope({
      values: [
        [st, 1],
        [st, 2],
      ],
    });

    // Last write wins: the second [st, 2] overwrites the first [st, 1].
    expect(scoped(s, () => st.value)).toBe(2);
  });

  it("keeps the last value across three duplicate store seeds", () => {
    const st = store("initial");
    const s = scope({
      values: [
        [st, "a"],
        [st, "b"],
        [st, "c"],
      ],
    });

    expect(scoped(s, () => st.value)).toBe("c");
  });

  it("keeps the last value when the same dependency is provided twice", () => {
    const dep = dependency<string>("api");
    const s = scope({
      deps: [
        [dep, "first"],
        [dep, "second"],
      ],
    });

    // Duplicate dep entries collapse to the last provided value.
    expect(scoped(s, () => dep.value)).toBe("second");
  });

  it("keeps the last handler when the same effect is overridden twice", async () => {
    const fx = effect(async () => "default");
    const s = scope({
      handlers: [
        [fx, async () => "override-1"],
        [fx, async () => "override-2"],
      ],
    });

    await expect(scoped(s, () => fx())).resolves.toBe("override-2");
  });

  it("isolates a last-wins duplicate seed from a sibling scope", () => {
    const st = store(0);
    const seeded = scope({
      values: [
        [st, 10],
        [st, 20],
      ],
    });
    const plain = scope();

    expect(scoped(seeded, () => st.value)).toBe(20);
    // The duplicate seed did not leak into an unseeded sibling.
    expect(scoped(plain, () => st.value)).toBe(0);
  });
});

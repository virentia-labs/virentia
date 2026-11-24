import { describe, expect, it } from "vitest";
import { computed, scope, scoped, store } from "../../lib";
import { withStoreDeclarationTracker, type StoreDeclaration } from "../../lib/internal";

// `store(initial)` and an unnamed `map(fn)` share one frozen options object, and
// a declaration object is built only for an installed tracker. None of it may
// show: every store keeps its own state and every declaration its shape.
describe("stores created with shared options", () => {
  it("still report every declaration in its usual shape", () => {
    const seen: StoreDeclaration[] = [];
    const units = withStoreDeclarationTracker((declaration) => seen.push(declaration), () => {
      const plain = store(1);
      const withSid = store(2, undefined, { sid: "shared-options" });
      const derived = computed(() => plain.value + 1);
      const mapped = plain.map((value) => value * 2);
      return [plain, withSid, derived, mapped];
    });

    expect(seen.map((declaration) => Object.keys(declaration))).toEqual([
      ["id", "sid", "identity"],
      ["id", "sid", "identity"],
      ["id", "identity"],
      ["id", "identity"],
    ]);
    expect(seen.map((declaration) => declaration.sid)).toEqual([
      undefined,
      "shared-options",
      undefined,
      undefined,
    ]);
    expect(seen.map((declaration) => declaration.identity)).toEqual(units.map((unit) => unit.node));
    expect(new Set(seen.map((declaration) => declaration.id)).size).toBe(4);
  });

  it("keep their own values and no skip token", () => {
    const app = scope();
    const first = store(1),
      second = store(1);
    scoped(app, () => {
      first.value = 5;
      second.value = undefined as unknown as number;
    });
    expect(scoped(app, () => [first.value, second.value])).toEqual([5, undefined]);
    expect(first.sid).toBeUndefined();
    expect(first.node).not.toBe(second.node);
  });

  it("map with and without a skip token as before", () => {
    const app = scope();
    const source = store(1);
    const plain = source.map((value) => (value > 2 ? -1 : value * 10));
    const skipping = source.map((value) => (value > 2 ? -1 : value * 10), -1);
    const other = store(7).map((value) => value + 1);
    const seen: number[] = [];
    skipping.subscribe((value) => seen.push(value));

    scoped(app, () => {
      source.value = 2;
    });
    expect(scoped(app, () => [plain.value, skipping.value, other.value])).toEqual([20, 20, 8]);
    scoped(app, () => {
      source.value = 3;
    });
    expect(scoped(app, () => [plain.value, skipping.value])).toEqual([-1, 20]);
    expect(seen).toEqual([20]);
  });
});

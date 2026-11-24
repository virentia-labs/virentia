import { describe, expect, it } from "vitest";
import { scope, scoped, serialize, store } from "../../lib";
import {
  releaseStoreDeclaration,
  withStoreDeclarationTracker,
  type StoreDeclaration,
} from "../../lib/internal";

describe("internal store declaration tracker", () => {
  it("tracks plain stores in the innermost synchronous frame and restores nested trackers", () => {
    const outer: StoreDeclaration[] = [];
    const inner: StoreDeclaration[] = [];
    const created = withStoreDeclarationTracker((declaration) => outer.push(declaration), () => {
      const first = store(1, undefined, { sid: "first" });
      expect(() =>
        withStoreDeclarationTracker((declaration) => inner.push(declaration), () => {
          store(2, undefined, { sid: "inner" });
          throw new Error("stop");
        }),
      ).toThrow("stop");
      const last = store(3);
      return { first, last };
    });
    store(4);

    expect(outer.map((declaration) => declaration.sid)).toEqual(["first", undefined]);
    expect(inner.map((declaration) => declaration.sid)).toEqual(["inner"]);
    expect(outer[0].id).toBeTypeOf("symbol");
    expect(outer[0].identity).toBe(created.first.node);
    expect(outer[1].identity).toBe(created.last.node);
  });

  it("releases state and SID registration without affecting a later store with that SID", () => {
    const declarations: StoreDeclaration[] = [];
    const first = withStoreDeclarationTracker((declaration) => declarations.push(declaration), () =>
      store(1, undefined, { sid: "local" }),
    );
    const app = scope();
    scoped(app, () => {
      first.value = 7;
    });
    expect(serialize(app)).toEqual({ local: 7 });

    releaseStoreDeclaration(app, declarations[0]);
    expect(app.values.has(declarations[0].id)).toBe(false);
    expect(serialize(app)).toEqual({});

    const replacement = store(3, undefined, { sid: "local" });
    expect(scoped(app, () => replacement.value)).toBe(3);
    expect(serialize(app)).toEqual({ local: 3 });

    // A stale cleanup must not remove a different store's registration.
    releaseStoreDeclaration(app, declarations[0]);
    expect(serialize(app)).toEqual({ local: 3 });
  });

  it("does not release a registered SID when the supplied identity differs", () => {
    const declarations: StoreDeclaration[] = [];
    const value = withStoreDeclarationTracker((declaration) => declarations.push(declaration), () =>
      store(1, undefined, { sid: "owned" }),
    );
    const app = scope();
    expect(scoped(app, () => value.value)).toBe(1);
    releaseStoreDeclaration(app, { ...declarations[0], identity: {} });
    expect(app.values.has(declarations[0].id)).toBe(true);
    expect(serialize(app)).toEqual({ owned: 1 });
  });
});

import { describe, expect, it } from "vitest";
import { effect, event, reaction, scope, scoped, store } from "../../lib";
import { getInspectorSnapshot, isInspectorEnabled } from "../../lib/kernel/inspector";

// Registration is eager but weak: opening devtools late still sees live units.
// WeakRefs survive the current job, so these synchronous checks cover discovery,
// not retention. weak-retention.test.ts verifies collection across GC turns.
describe("inspector registries with devtools never enabled", () => {
  it("is disabled by default", () => {
    expect(isInspectorEnabled()).toBe(false);
  });

  it("discovers scopes registered before inspection is enabled", () => {
    const before = getInspectorSnapshot().scopes.length;

    // A server handling requests creates a scope per request.
    for (let i = 0; i < 500; i += 1) {
      const requestScope = scope();

      scoped(requestScope, () => {
        // scope used and then dropped — nothing references it afterwards
      });
    }

    const after = getInspectorSnapshot().scopes.length;

    expect(after - before).toBe(500);
  });

  it("discovers units registered before inspection is enabled", () => {
    const before = getInspectorSnapshot().nodes.length;

    // A model instantiated per screen/session creates fresh units each time.
    for (let i = 0; i < 200; i += 1) {
      const $n = store(0);
      const go = event<void>();

      reaction({ on: go, run: () => void ($n.value += 1) });
    }

    const after = getInspectorSnapshot().nodes.length;

    expect(after - before).toBeGreaterThanOrEqual(200);
  });

  it("discovers a still-live effect", () => {
    const before = getInspectorSnapshot().nodes.length;
    const fx = effect(async () => 1);

    void fx;

    const after = getInspectorSnapshot().nodes.length;

    expect(after).toBeGreaterThan(before);
  });
});

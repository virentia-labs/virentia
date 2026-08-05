import { describe, expect, it } from "vitest";
import { effect, event, reaction, scope, scoped, store } from "../../lib";
import { getInspectorSnapshot, isInspectorEnabled } from "../../lib/kernel/inspector";

// Devtools are opt-in, but the registries that back them are populated from the
// very first unit. These probes measure what an app pays when nobody ever opened
// the inspector — the production case.
//
// This is a CHARACTERIZATION of an accepted trade-off, not an endorsement: the
// registries are eager so that opening the inspector mid-session shows the units
// that already exist. Gating registration on `enabled` removes the retention at
// no byte cost, but then devtools only ever see units created after they were
// switched on. Revisit together — do not "fix" one side in isolation.
describe("inspector registries with devtools never enabled", () => {
  it("is disabled by default", () => {
    expect(isInspectorEnabled()).toBe(false);
  });

  it("retains every scope ever created", () => {
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

  it("retains every unit ever created", () => {
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

  it("retains the units of a disposed model", () => {
    const before = getInspectorSnapshot().nodes.length;
    const fx = effect(async () => 1);

    void fx;

    const after = getInspectorSnapshot().nodes.length;

    expect(after).toBeGreaterThan(before);
  });
});

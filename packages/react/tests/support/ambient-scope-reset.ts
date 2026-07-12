import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
// Test-only: reset core's module-global ambient scope between tests (see afterEach).
import { setActiveScope } from "../../../core/lib/scope/internal";

// Registers the per-test hygiene teardown shared by every runtime suite split
// out of the original react-behavior suite. Call once at module top level.
export function resetAmbientScopeAfterEach() {
  afterEach(async () => {
    cleanup();
    // Flush a macrotask so any fire-and-forget `scoped(...)` promise chain from a
    // click settles and restores the ambient scope before the next test runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Test hygiene: a render that crashes mid-flight (the Rules-of-Hooks probes)
    // or overlapping async `scoped(...)` calls can leave core's module-global
    // active scope set. Force it back to null so per-test isolation holds
    // (notably CO8, which asserts there is NO active scope). See suspected core
    // bug in the report.
    setActiveScope(null);
  });
}

import { setActiveScope } from "../../lib/internal";

// The ambient scope is global module state. Async fire-and-forget units (an
// awaited-then-detached event, an effect's internal settle events) can re-install
// their calling scope after their drain settles, leaking it past a test. Neutralize
// it between tests so a leak from one test cannot masquerade as another's failure —
// each test that cares about the ambient still asserts it explicitly.
export function resetActiveScope(): void {
  setActiveScope(null);
}

// A deterministic microtask flush helper.
export const flush = async (times = 6): Promise<void> => {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
};

import { scope, scoped } from "../../lib";

// A microtask flush that settles any fire-and-forget kernel propagation. Store
// proxy writes drain synchronously for sync downstream, but flushing keeps the
// async paths deterministic.
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
};

// Read a store's `.value` inside a scope (drives the scoped read path).
export const readValue = <T>(sc: ReturnType<typeof scope>, s: { value: T }): T =>
  scoped(sc, () => s.value);

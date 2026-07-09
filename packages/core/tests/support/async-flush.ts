// Deterministic microtask helpers shared across the event / effect / di suites.
// Every drain gates on a fixed number of resolved-promise ticks (never
// wall-clock / timers): a handful of drains settles an effect start, an abort,
// or a lazy-load chain. The count is generous so it covers the longest chain
// any caller needs.
export async function flush(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

// A promise that never settles — models an in-flight async handler controllable
// only via abort.
export function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

// A single microtask tick.
export const tick = (): Promise<void> => Promise.resolve();

export function waitForMicrotask(): Promise<void> {
  return Promise.resolve();
}

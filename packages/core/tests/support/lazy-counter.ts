import { event, reaction, store, type EventCallable, type StoreWritable } from "../../lib";

export interface CounterModel {
  count: StoreWritable<number>;
  incremented: EventCallable<number>;
}

// Builds a fresh, fully-wired counter model (count store + incremented event +
// reaction). Returned so tests can capture the *real* underlying units.
export function makeCounter(): CounterModel & { load(): Promise<CounterModel> } {
  const count = store(0);
  const incremented = event<number>();
  reaction({
    on: incremented,
    run(amount: number) {
      count.value += amount;
    },
  });

  return { count, incremented, load: async () => ({ count, incremented }) };
}

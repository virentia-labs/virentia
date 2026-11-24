import { expect, it } from "vitest";
import { reaction, scope, scoped, store, type Store } from "../../lib";

it("notifies a subscriber attached by an earlier queued source reaction", () => {
  const app = scope();
  const source = store(1);
  const seen: number[] = [];
  let derived!: Store<number>;
  let unsubscribe: (() => void) | undefined;
  // Explicit reactions do not run on declaration. This observer is registered
  // before the derived store, so it can subscribe during the same update.
  const installer = reaction({
    on: source,
    run() {
      unsubscribe = derived.subscribe((value) => { seen.push(value); });
    },
  });
  derived = source.map((value) => value * 10);

  try {
    expect(scoped(app, () => derived.value)).toBe(10);
    scoped(app, () => { source.value = 2; });
    expect(seen).toEqual([20]);
  } finally {
    unsubscribe?.();
    installer.stop();
  }
});

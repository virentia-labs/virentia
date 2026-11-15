import { expect, it } from "vitest";
import { computed, event, owner, reaction, scope, scoped, store } from "../../lib";
import { nativeModel, nativeTrait } from "../../lib/internal";

it("constructs native traits only on demand, deduplicates parents, and inherits scope/owner", async () => {
  let setups = 0;
  const Base = nativeTrait<number>()({ setup(_self, initial) {
    setups++;
    const cell = store(initial), change = event<number>();
    reaction({ on: change, run(value) { cell.value = value; } });
    return { state: computed(() => cell.value), change };
  } });
  const Left = nativeTrait<number>()({ with: [Base], setup() { return { left: true }; } });
  const Right = nativeTrait<number>()({ with: [Base], setup() { return { right: true }; } });
  const create = nativeModel<number>()({ with: [Left, Right], setup(self) {
    return { read: () => self.state.value };
  } });
  expect(setups).toBe(0);
  const feature = owner(() => ({ first: create(1), second: create(2) }));
  expect(setups).toBe(2);
  expect(feature.first.state.node).not.toBe(feature.second.state.node);
  const a = scope(), b = scope();
  await scoped(a, () => feature.first.change(10));
  expect(scoped(a, () => feature.first.read())).toBe(10);
  expect(scoped(b, () => feature.first.read())).toBe(1);
  expect(scoped(a, () => feature.second.read())).toBe(2);
  feature.dispose();
  await scoped(a, () => feature.first.change(20));
  expect(scoped(a, () => feature.first.read())).toBe(10);
});

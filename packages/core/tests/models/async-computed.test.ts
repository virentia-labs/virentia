import { computed, effect, event, reaction, scope, scoped } from "../../lib";
import { f, staticModel } from "../../lib/models";
import { expect, it } from "vitest";

it("invalidates a model computed on every write after a direct unit await", async () => {
  const tick = effect(async () => {});
  const Model = staticModel({ data: { count: f.number(0) }, setup(self) {
    const changed = event<void>();
    reaction({ on: changed, run: async () => { await tick(); self.count.value++; } });
    return { changed, double: computed(() => self.count.value * 2) };
  } });
  const home = scope();
  const instance = scoped(home, () => Model.create({}));
  expect(instance.double.value).toBe(0);
  for (let index = 1; index <= 3; index++) {
    await instance.changed();
    expect(instance.count.value).toBe(index);
    expect(instance.double.value).toBe(index * 2);
  }
});

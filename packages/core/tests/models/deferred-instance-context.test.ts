import { expect, it } from "vitest";
import { event, reaction, scope, scoped, serialize, store } from "../../lib";
import { staticModel } from "../../lib/models";

for (const firstReader of ["member SID", "serialize"] as const) {
  it(`keeps untouched instance contexts when ${firstReader} flushes deferred snapshots`, async () => {
    const Draft = staticModel({
      name: "DeferredInstanceContext",
      setup(self) {
        const saved = store(0, undefined, { sid: "saved" });
        const change = event<number>();
        reaction({ on: change, run(value) { saved.value = value; } });
        return { saved, change, identify: () => self.id };
      },
    });
    const app = scope();
    const [a, b] = scoped(app, () => Draft.create([{ id: "a" }, { id: "b" }]));
    try {
      // The flush materializes b's scope before any member of b is used.
      if (firstReader === "serialize") serialize(app);
      else expect(a.saved.value).toBe(0);

      await b.change(2);
      expect(b.saved.value).toBe(2);
      expect(b.identify()).toBe("b");
      expect(a.saved.value).toBe(0);
      expect(a.identify()).toBe("a");
      const values = Object.entries(serialize(app))
        .filter(([sid]) => sid.endsWith("/saved"))
        .map(([, value]) => value);
      expect(values.sort()).toEqual([0, 2]);
    } finally {
      await a.dispose(); await b.dispose();
    }
  });
}

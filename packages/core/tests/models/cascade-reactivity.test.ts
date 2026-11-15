import { expect, it } from "vitest";
import { computed, reaction, scope, scoped, setErrorReporter, type VirentiaFailureReport } from "../../lib";
import { scopedModelValue } from "../../lib/internal";
import { children, f, refs, staticModel } from "../../lib/models";

it("detaches a parent's reactive graph before disposing the children it reads", async () => {
  const Leaf = staticModel({ data: { value: f.number(1) } });
  const Child = staticModel({ data: { owned: children.many(Leaf), linked: refs.many(Leaf).policy("nullify") },
    setup(self) { return { api: scopedModelValue({ state: computed(() => self.linked.items.reduce((sum, item) => sum + item.value.value, 0)) }) }; },
    onCreate(self) { self.linked.add(self.owned.add({})); },
  });
  const Parent = staticModel({ data: { first: children.one(Child), second: children.one(Child) },
    setup(self) {
      const fields = computed(() => [self.first.value!.api, self.second.value!.api]);
      return { total: computed(() => fields.value.reduce((sum, api) => sum + api.state.value, 0)) };
    }, onCreate(self) { self.first.create({}); self.second.create({}); },
  });
  const app = scope(), [a, b] = scoped(app, () => Parent.create([{}, {}]));
  const failures: VirentiaFailureReport[] = [];
  const first = reaction({ on: a.total, run() {} }), second = reaction({ on: b.total, run() {} });
  setErrorReporter(report => failures.push(report));
  try {
    expect(a.total.value).toBe(2);
    await a.dispose();
    expect(failures).toEqual([]);
    b.first.value!.owned.items[0].value.value = 3;
    expect(b.total.value).toBe(4);
  } finally { first.stop(); second.stop(); await a.dispose(); await b.dispose(); setErrorReporter(null); }
});

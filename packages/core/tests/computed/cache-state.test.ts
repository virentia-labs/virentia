import { expect, it } from "vitest";
import { computed, scope, scoped, serialize, store } from "../../lib";
import { captureScopeSnapshot } from "../../lib/internal";
import { f, staticModel } from "../../lib/models";

it("caches undefined computed output and notifies when a later value becomes undefined", () => {
  const app = scope(), source = store(0);
  let calls = 0;
  const result = computed(() => {
    calls++;
    return source.value ? source.value * 2 : undefined;
  });
  expect(scoped(app, () => [result.value, result.value])).toEqual([undefined, undefined]);
  expect(calls).toBe(1);
  const seen: (number | undefined)[] = [];
  const off = result.subscribe((value) => seen.push(value));
  const subscribedCalls = calls;
  try {
    scoped(app, () => { source.value = 1; });
    scoped(app, () => { source.value = 0; });
    expect(seen).toEqual([2, undefined]);
    expect(scoped(app, () => result.value)).toBeUndefined();
    expect(calls).toBe(subscribedCalls + 2);
  } finally {
    off();
  }
});

it("rebuilds an undefined computed cache from captured snapshot values independently", () => {
  const source = store(0, undefined, { sid: "undefined-cache-source" });
  let calls = 0;
  const result = computed(() => {
    calls++;
    return source.value ? source.value * 2 : undefined;
  });
  const live = scope();
  expect(scoped(live, () => result.value)).toBeUndefined();
  const frozen = captureScopeSnapshot(live);
  scoped(live, () => { source.value = 2; });
  expect(scoped(live, () => result.value)).toBe(4);
  expect(scoped(frozen, () => [result.value, result.value])).toEqual([undefined, undefined]);
  expect(calls).toBe(3);
  expect(serialize(frozen)).toEqual({ "undefined-cache-source": 0 });
  expect(serialize(live)).toEqual({ "undefined-cache-source": 2 });
});

it("does not retain an undefined computed cache when a disposed model scope is reused", async () => {
  let calls = 0;
  const Row = staticModel({
    data: { count: f.number(0) },
    setup(self) {
      return { result: computed(() => {
        calls++;
        return self.count.value || undefined;
      }) };
    },
  });
  const app = scope();
  const first = scoped(app, () => Row.create({ id: "row" }));
  const oldResult = first.result;
  expect([oldResult.value, oldResult.value]).toEqual([undefined, undefined]);
  await first.dispose();
  const second = scoped(app, () => Row.create({ id: "row", count: 9 }));
  expect(second.result.value).toBe(9);
  expect(() => oldResult.value).toThrow("disposed");
  await second.dispose();
  const third = scoped(app, () => Row.create({ id: "row" }));
  expect([third.result.value, third.result.value]).toEqual([undefined, undefined]);
  expect(calls).toBe(3);
  await third.dispose();
});

import { expect, it, vi } from "vitest";
import { scope, scoped, store, serialize } from "../../lib";
import { nativeStoreStateOf } from "../../lib/units/store";
import { withTransaction } from "../../lib/internal";

it("reads a committed native value once before an isolated write", () => {
  const state = store(0);
  const app = scope({ values: [[state, 1]] });
  const read = vi.spyOn(app.values, "get");
  try {
    scoped(app, () => {
      state.value = 2;
    });
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    read.mockRestore();
  }
  expect(scoped(app, () => state.value)).toBe(2);
});

it.each([false, true])(
  "rolls an isolated throwing commit back, including absent state (%s)",
  (present) => {
    const state = store<number | undefined>(0);
    const id = nativeStoreStateOf(state)!.id;
    const app = scope(present ? { values: [[state, undefined]] } : {});
    const original = app.values.set.bind(app.values);
    const write = vi.spyOn(app.values, "set").mockImplementationOnce((key, value) => {
      original(key, value);
      throw Error("failed native commit");
    });
    try {
      expect(() =>
        scoped(app, () => {
          state.value = 2;
        }),
      ).toThrow("failed native commit");
    } finally {
      write.mockRestore();
    }
    expect(app.values.has(id)).toBe(present);
    expect(scoped(app, () => state.value)).toBe(present ? undefined : 0);
  },
);

it("materializes a pending SID snapshot before an isolated commit and rollback", () => {
  const state = store(0, undefined, { sid: "known-native-snapshot" });
  const app = scope({ snapshot: { "known-native-snapshot": 7 } });
  const original = app.values.set.bind(app.values);
  const write = vi.spyOn(app.values, "set").mockImplementation((key, value) => {
    original(key, value);
    if (value === 8) throw Error("failed snapshot commit");
    return app.values;
  });
  try {
    expect(() =>
      scoped(app, () => {
        state.value = 8;
      }),
    ).toThrow("failed snapshot commit");
  } finally {
    write.mockRestore();
  }
  expect(scoped(app, () => state.value)).toBe(7);
  expect(serialize(app)["known-native-snapshot"]).toBe(7);
});

it("retains pending reads and atomic notifications inside explicit transactions", () => {
  const state = store(0),
    app = scope();
  const seen: number[] = [];
  state.subscribe((value) => seen.push(value));
  scoped(app, () =>
    withTransaction(() => {
      state.value = 1;
      expect(state.value).toBe(1);
      state.value = 2;
      expect(state.value).toBe(2);
      expect(seen).toEqual([]);
    }),
  );
  expect(seen).toEqual([2]);
});

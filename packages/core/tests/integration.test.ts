import { describe, expect, it } from "vitest";
import { allSettled, effect, event, owner, reaction, reactive, scope, store, scoped } from "../lib";

describe("reactive integration", () => {
  it("updates a counter from events and publishes derived values", async () => {
    const appScope = scope();
    const incremented = event<number>();
    const count = store(0);
    const doubled = count.map((value) => value * 2);
    const visible = doubled.filter((value) => value >= 4);
    const values: number[] = [];

    reaction({
      on: incremented,
      run: (amount: number) => {
        count.value += amount;
      },
    });
    reaction({
      on: visible,
      run: (value: number) => {
        values.push(value);
      },
    });

    await allSettled(incremented, { scope: appScope, payload: 1 });
    await allSettled(incremented, { scope: appScope, payload: 1 });
    await allSettled(incremented, { scope: appScope, payload: 3 });

    scoped(appScope, () => {
      expect(count.value).toBe(5);
    });
    expect(values).toEqual([4, 10]);
  });

  it("keeps one reactive graph isolated between scopes", async () => {
    const firstScope = scope();
    const secondScope = scope();
    const added = event<number>();
    const count = store(0);
    const snapshots: unknown[] = [];

    reaction({
      on: added,
      run: (amount: number) => {
        count.value += amount;
      },
    });
    reaction({
      on: count,
      run: (value: number) => {
        snapshots.push([value, count.value]);
      },
    });

    await allSettled(added, { scope: firstScope, payload: 2 });
    await allSettled(added, { scope: secondScope, payload: 10 });
    await allSettled(added, { scope: firstScope, payload: 3 });

    scoped(firstScope, () => {
      expect(count.value).toBe(5);
    });
    scoped(secondScope, () => {
      expect(count.value).toBe(10);
    });
    expect(snapshots).toEqual([
      [2, 2],
      [10, 10],
      [5, 5],
    ]);
  });

  it("coordinates form events, async effect, and scoped state", async () => {
    const appScope = scope();
    const queryChanged = event<string>();
    const submitted = event();
    const query = store("");
    const status = store<"idle" | "loading" | "ready">("idle");
    const results = reactive({ items: [] as string[] });
    const searchFx = effect(async (text: string) => {
      await Promise.resolve();
      return [`${text}:first`, `${text}:second`];
    });

    reaction({
      on: queryChanged,
      run: (text: string) => {
        query.value = text;
      },
    });
    reaction({
      on: submitted,
      run: () => {
        void searchFx(query.value);
      },
    });
    reaction({
      on: searchFx.started,
      run: () => {
        status.value = "loading";
      },
    });
    reaction({
      on: searchFx.doneData,
      run: (items: string[]) => {
        results.items = items;
        status.value = "ready";
      },
    });

    await allSettled(queryChanged, { scope: appScope, payload: "virentia" });
    await allSettled(submitted, { scope: appScope });

    scoped(appScope, () => {
      expect(query.value).toBe("virentia");
      expect(status.value).toBe("ready");
      expect(results.items).toEqual(["virentia:first", "virentia:second"]);
      expect(searchFx.pending.value).toBe(false);
    });
  });

  it("keeps derived state in sync through auto-tracked reaction reads", async () => {
    const appScope = scope();
    const firstNameChanged = event<string>();
    const lastNameChanged = event<string>();
    const firstName = store("Grace");
    const lastName = store("Hopper");
    const fullName = store("");

    reaction({
      on: firstNameChanged,
      run: (value: string) => {
        firstName.value = value;
      },
    });

    reaction({
      on: lastNameChanged,
      run: (value: string) => {
        lastName.value = value;
      },
    });

    reaction(() => {
      fullName.value = `${firstName.value} ${lastName.value}`;
    });

    await allSettled(firstNameChanged, { scope: appScope, payload: "Ada" });
    await allSettled(lastNameChanged, {
      scope: appScope,
      payload: "Lovelace",
    });

    scoped(appScope, () => {
      expect(fullName.value).toBe("Ada Lovelace");
    });
  });

  it("switches auto-tracked dependencies inside conditional branches", async () => {
    const appScope = scope();
    const sourceChanged = event<"local" | "remote">();
    const localChanged = event<string>();
    const remoteChanged = event<string>();
    const source = store<"local" | "remote">("local");
    const local = store("draft");
    const remote = store("server");
    const visibleValues: string[] = [];

    reaction({
      on: sourceChanged,
      run: (value: "local" | "remote") => {
        source.value = value;
      },
    });
    reaction({
      on: localChanged,
      run: (value: string) => {
        local.value = value;
      },
    });
    reaction({
      on: remoteChanged,
      run: (value: string) => {
        remote.value = value;
      },
    });
    reaction(() => {
      visibleValues.push(source.value === "local" ? local.value : remote.value);
    });

    await allSettled(remoteChanged, {
      scope: appScope,
      payload: "server-v2",
    });
    await allSettled(localChanged, { scope: appScope, payload: "draft-v2" });
    await allSettled(sourceChanged, { scope: appScope, payload: "remote" });
    await allSettled(localChanged, { scope: appScope, payload: "draft-v3" });
    await allSettled(remoteChanged, {
      scope: appScope,
      payload: "server-v3",
    });

    expect(visibleValues).toEqual(["draft", "draft-v2", "server-v2", "server-v3"]);
  });

  it("turns off dynamic model reactions when the model is disposed", async () => {
    const appScope = scope();
    const savedValues: number[] = [];
    const model = owner((dispose) => {
      const incremented = event<number>();
      const count = store(0);
      const saveFx = effect(async (value: number) => value);

      reaction({
        on: incremented,
        run: (amount: number) => {
          count.value += amount;
          void saveFx(count.value);
        },
      });

      return {
        count,
        dispose,
        incremented,
        saveFx,
      };
    });

    reaction({
      on: model.saveFx.doneData,
      run: (value: number) => {
        savedValues.push(value);
      },
    });

    await allSettled(model.incremented, { scope: appScope, payload: 2 });
    model.dispose();
    await allSettled(model.incremented, { scope: appScope, payload: 3 });

    scoped(appScope, () => {
      expect(model.count.value).toBe(2);
      expect(model.saveFx.pending.value).toBe(false);
    });
    expect(savedValues).toEqual([2]);
  });
});

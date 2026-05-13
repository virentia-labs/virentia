import { describe, test, expect, expectTypeOf, vi } from "vitest";
import {
  child,
  contract,
  define,
  model,
  ref,
  type TBoolean,
  type TNumber,
  type TString,
  type TStatic,
  union,
  withInstanceContext,
} from "@effector-kit/models";
import {
  allSettled,
  combine,
  createEvent,
  createStore,
  fork,
  sample,
  type EventCallable,
} from "effector";

async function createInstances(
  scope: ReturnType<typeof fork>,
  create: EventCallable<any>,
  params: any[],
) {
  await allSettled(create, { scope, params });
}

const todoList = model({
  contract: contract({
    title: define.store(define.schema<TString>(), ""),
    done: define.store(define.schema<TBoolean>(), false),
    changeDone: define.event(define.schema<TBoolean>()),
  })(),
  fn: ({ title, done, changeDone }) => {
    sample({
      clock: changeDone,
      target: done,
    });

    return {
      title,
      done,
      changeDone,
    };
  },
});

const counterModel = model({
  contract: contract({
    count: define.store(define.schema<TNumber>(), 0),
  })(),
  fn: ({ count }) => {
    const setCount = createEvent<number>();
    const increment = createEvent<void>();

    sample({
      clock: setCount,
      target: count,
    });

    sample({
      clock: increment,
      source: count,
      fn: (value) => value + 1,
      target: count,
    });

    return {
      count,
      setCount,
      increment,
    };
  },
});

const flaggedModel = model({
  contract: contract({
    score: define.store(define.schema<TNumber>(), 0),
  })(),
  fn: ({ score }) => {
    const setScore = createEvent<number>();

    sample({
      clock: setScore,
      target: score,
    });

    return {
      score,
      setScore,
    };
  },
});

const itemModel = model({
  contract: contract({
    value: define.store(define.schema<TNumber>(), 0),
  })(),
  fn: ({ value }) => {
    const setValue = createEvent<number>();

    sample({
      clock: setValue,
      target: value,
    });

    return {
      value,
      setValue,
    };
  },
});

function createDashboardModel() {
  return model({
    contract: contract({
      name: define.store(define.schema<TString>(), ""),
    })(),
    fn: ({ name }) => {
      const selected = ref(counterModel);
      const track = createEvent<string>();
      const untrack = createEvent<string>();
      const setSelectedCount = createEvent<number>();
      const deleteSelected = createEvent<void>();

      sample({
        clock: track,
        target: selected.add,
      });

      sample({
        clock: untrack,
        target: selected.remove,
      });

      sample({
        clock: setSelectedCount,
        target: selected.lens.count.target(),
      });

      sample({
        clock: deleteSelected,
        target: selected.lens.delete(),
      });

      return {
        name,
        track,
        untrack,
        setSelectedCount,
        deleteSelected,
        selectedCountChanged: selected.lens.count.clock(),
        selected,
      };
    },
  });
}

function createDashboardUnionModel() {
  return model({
    contract: contract({
      name: define.store(define.schema<TString>(), ""),
    })(),
    fn: ({ name }) => {
      const selected = ref(union({ counter: counterModel, flagged: flaggedModel }));

      const trackCounter = createEvent<string>();
      const untrackCounter = createEvent<string>();
      const trackFlagged = createEvent<string>();
      const untrackFlagged = createEvent<string>();
      const setSelectedValue = createEvent<number>();
      const setCounterOnly = createEvent<number>();
      const deleteSelected = createEvent<void>();
      const setFirstSelectedValue = createEvent<number>();
      const setLastSelectedValue = createEvent<number>();
      const setWithIsolatedMatch = createEvent<number>();
      const setMatchedByContext = createEvent<number>();
      const setByUniqueId = createEvent<number>();

      sample({
        clock: trackCounter,
        target: selected.add.counter,
      });

      sample({
        clock: untrackCounter,
        target: selected.remove.counter,
      });

      sample({
        clock: trackFlagged,
        target: selected.add.flagged,
      });

      sample({
        clock: untrackFlagged,
        target: selected.remove.flagged,
      });

      sample({
        clock: setSelectedValue,
        target: selected.lens.match({
          counter: (sub) => sub.count.target(),
          flagged: (sub) => sub.score.target(),
        }),
      });

      sample({
        clock: setCounterOnly,
        target: selected.lens.only("counter").counter.count.target(),
      });

      sample({
        clock: deleteSelected,
        target: selected.lens.match({
          counter: (sub) => sub.delete(),
          flagged: (sub) => sub.delete(),
        }),
      });

      sample({
        clock: setFirstSelectedValue,
        target: selected.lens.first().match({
          counter: (sub) => sub.count.target(),
          flagged: (sub) => sub.score.target(),
        }),
      });

      sample({
        clock: setLastSelectedValue,
        target: selected.lens.last().match({
          counter: (sub) => sub.count.target(),
          flagged: (sub) => sub.score.target(),
        }),
      });

      sample({
        clock: setWithIsolatedMatch,
        target: selected.lens.match({
          counter: (sub) => sub.where((entity) => entity.count < 0).count.target(),
          flagged: (sub) => sub.where((entity) => entity.score >= 0).score.target(),
        }),
      });

      sample({
        clock: setMatchedByContext,
        target: selected.lens
          .where(
            (entity, _, ctx) =>
              ctx?.match({
                counter: (counter) => counter.count > 0,
                flagged: (flagged) => flagged.score > 0,
              }) ?? false,
          )
          .match({
            counter: (sub) => sub.count.target(),
            flagged: (sub) => sub.score.target(),
          }),
      });

      sample({
        clock: setByUniqueId,
        target: selected.lens
          .only("counter")
          .where(
            (entity, _, ctx) => ctx?.uniqueId("counter", entity.id) === `${counterModel["~id"]}:a`,
          )
          .counter.count.target(),
      });

      return {
        name,
        trackCounter,
        untrackCounter,
        trackFlagged,
        untrackFlagged,
        setSelectedValue,
        setCounterOnly,
        deleteSelected,
        setFirstSelectedValue,
        setLastSelectedValue,
        setWithIsolatedMatch,
        setMatchedByContext,
        setByUniqueId,
      };
    },
  });
}

function createListModel() {
  return model({
    contract: contract({
      title: define.store(define.schema<TString>(), ""),
    })(),
    fn: ({ title }) => {
      const items = child(itemModel);
      const createItem = createEvent<{ id: string; data: { value: number } }>();
      const removeItem = createEvent<string>();
      const setItemsValue = createEvent<number>();

      sample({
        clock: createItem,
        target: items.create,
      });

      sample({
        clock: removeItem,
        target: items.delete,
      });

      sample({
        clock: setItemsValue,
        target: items.lens.value.target(),
      });

      return {
        title,
        createItem,
        removeItem,
        setItemsValue,
        itemsValueChanged: items.lens.value.clock(),
        items,
      };
    },
  });
}

function getChildInstancesByParent(
  scope: ReturnType<typeof fork>,
  parentModel: { $instances: { getState(): Record<string, any> } },
  childModel: { ["~id"]: string },
  parentId: string,
) {
  const parentInstances = scope.getState(parentModel.$instances as any) as Record<string, any>;

  return parentInstances[parentId]?.["~children"]?.[childModel["~id"]] ?? {};
}

describe("models api", () => {
  test("contract events keep concrete payload types in model fn", () => {
    const chatInfoModel = model({
      contract: contract({
        mounted: define.event(define.schema<TStatic<{ id: string }>>()),
      })(),
      fn: ({ mounted }) => {
        expectTypeOf(mounted).toMatchTypeOf<EventCallable<{ id: string }>>();

        return { mounted };
      },
    });

    expect(chatInfoModel).toBeDefined();
  });

  test("model can call external units with correct instance-scoped source data", async () => {
    const externalReported = createEvent<{ count: number; label: string }>();
    const $externalSnapshot = createStore<string | null>(null);
    const seen: Array<{ count: number; label: string }> = [];

    externalReported.watch((payload) => {
      seen.push(payload);
    });

    const reportModel = model({
      contract: contract({
        count: define.store(define.schema<TNumber>(), 0),
      })(),
      fn: ({ count }) => {
        const report = createEvent<string>();

        sample({
          clock: report,
          source: count,
          fn: (value, label) => ({ count: value, label }),
          target: externalReported,
        });

        sample({
          clock: report,
          source: count,
          fn: (value, label) => `${label}:${value}`,
          target: $externalSnapshot,
        });

        return {
          count,
          report,
        };
      },
    });

    const scope = fork();

    await allSettled(reportModel.create, {
      scope,
      params: [
        { id: "a", data: { count: 1 } },
        { id: "b", data: { count: 2 } },
      ],
    });

    await allSettled(reportModel.lens.where((entity) => entity.id === "b").report.target(), {
      scope,
      params: "selected",
    });

    expect(seen).toStrictEqual([{ count: 2, label: "selected" }]);
    expect(scope.getState($externalSnapshot)).toBe("selected:2");
  });

  test("subscription to external unit applies to all model instances", async () => {
    const incrementAll = createEvent<number>();

    const syncedCounterModel = model({
      contract: contract({
        count: define.store(define.schema<TNumber>(), 0),
      })(),
      fn: ({ count }) => {
        sample({
          clock: incrementAll,
          source: count,
          fn: (value, delta) => value + delta,
          target: count,
        });

        return {
          count,
        };
      },
    });

    const scope = fork();

    await allSettled(syncedCounterModel.create, {
      scope,
      params: [
        { id: "a", data: { count: 1 } },
        { id: "b", data: { count: 5 } },
        { id: "c", data: { count: 10 } },
      ],
    });

    await allSettled(incrementAll, {
      scope,
      params: 3,
    });

    expect(scope.getState(syncedCounterModel.$instances)).toStrictEqual({
      a: { count: 4 },
      b: { count: 8 },
      c: { count: 13 },
    });
  });

  test("derived stores recompute inside model instances without ui", async () => {
    const profileModel = model({
      contract: contract({
        firstName: define.store(define.schema<TString>(), ""),
        lastName: define.store(define.schema<TString>(), ""),
      })(),
      fn: ({ firstName, lastName }) => {
        const firstNameChanged = createEvent<string>();
        const lastNameChanged = createEvent<string>();
        const $fullName = combine(firstName, lastName, (first, last) => `${first} ${last}`.trim());
        const $fullNameUpper = $fullName.map((value) => value.toUpperCase());

        sample({
          clock: firstNameChanged,
          target: firstName,
        });

        sample({
          clock: lastNameChanged,
          target: lastName,
        });

        return {
          firstName,
          lastName,
          $fullName,
          $fullNameUpper,
          firstNameChanged,
          lastNameChanged,
        };
      },
    });

    const scope = fork();

    await createInstances(scope, profileModel.create, [
      {
        id: "profile-1",
        data: { firstName: "Ada", lastName: "Lovelace" },
      },
    ]);

    const readInstance = () => {
      const instance = scope.getState(profileModel.$instances)["profile-1"];

      if (!instance) {
        throw new Error("profile-1 instance is missing");
      }

      return withInstanceContext(profileModel, instance, () => ({
        fullName: profileModel["~api"].$fullName.getState(),
        fullNameUpper: profileModel["~api"].$fullNameUpper.getState(),
      }));
    };

    expect(readInstance()).toStrictEqual({
      fullName: "Ada Lovelace",
      fullNameUpper: "ADA LOVELACE",
    });

    await allSettled(
      profileModel.lens.where((entity) => entity.id === "profile-1").firstNameChanged.target(),
      {
        scope,
        params: "Grace",
      },
    );

    expect(readInstance()).toStrictEqual({
      fullName: "Grace Lovelace",
      fullNameUpper: "GRACE LOVELACE",
    });
  });

  test("derived store watch receives updated value inside model instance", async () => {
    const scope = fork();
    const watcher = vi.fn();

    const profileModel = model({
      contract: contract({
        firstName: define.store(define.schema<TString>(), ""),
        lastName: define.store(define.schema<TString>(), ""),
      })(),
      fn: ({ firstName, lastName }) => {
        const firstNameChanged = createEvent<string>();
        const $fullName = combine(firstName, lastName, (first, last) => `${first} ${last}`.trim());

        sample({
          clock: firstNameChanged,
          target: firstName,
        });

        $fullName.watch(watcher);

        return {
          firstName,
          lastName,
          $fullName,
          firstNameChanged,
        };
      },
    });

    watcher.mockClear();

    await createInstances(scope, profileModel.create, [
      {
        id: "profile-1",
        data: { firstName: "Ada", lastName: "Lovelace" },
      },
    ]);

    watcher.mockClear();

    await allSettled(
      profileModel.lens.where((entity) => entity.id === "profile-1").firstNameChanged.target(),
      {
        scope,
        params: "Grace",
      },
    );

    expect(watcher).toHaveBeenCalled();
    expect(watcher.mock.calls.at(-1)).toStrictEqual(["Grace Lovelace"]);
  });

  test("derived store updates trigger downstream graph inside model instances", async () => {
    const profileModel = model({
      contract: contract({
        firstName: define.store(define.schema<TString>(), ""),
        lastName: define.store(define.schema<TString>(), ""),
        lastDerivedValue: define.store(define.schema<TString>(), ""),
      })(),
      fn: ({ firstName, lastName, lastDerivedValue }) => {
        const firstNameChanged = createEvent<string>();
        const lastNameChanged = createEvent<string>();
        const $fullName = combine(firstName, lastName, (first, last) => `${first} ${last}`.trim());

        sample({
          clock: firstNameChanged,
          target: firstName,
        });

        sample({
          clock: lastNameChanged,
          target: lastName,
        });

        sample({
          clock: $fullName.updates,
          target: lastDerivedValue,
        });

        return {
          firstName,
          lastName,
          lastDerivedValue,
          $fullName,
          firstNameChanged,
          lastNameChanged,
        };
      },
    });

    const scope = fork();

    await createInstances(scope, profileModel.create, [
      {
        id: "profile-1",
        data: { firstName: "Ada", lastName: "Lovelace" },
      },
    ]);

    await allSettled(
      profileModel.lens.where((entity) => entity.id === "profile-1").firstNameChanged.target(),
      {
        scope,
        params: "Grace",
      },
    );

    const instance = scope.getState(profileModel.$instances)["profile-1"];

    expect(instance).toBeDefined();
    expect(instance!.lastDerivedValue).toBe("Grace Lovelace");

    const values = withInstanceContext(
      profileModel,
      instance!,
      () => ({
        fullName: profileModel["~api"].$fullName.getState(),
        lastDerivedValue: profileModel["~api"].lastDerivedValue.getState(),
      }),
      scope,
    );

    expect(values).toStrictEqual({
      fullName: "Grace Lovelace",
      lastDerivedValue: "Grace Lovelace",
    });
  });

  test("nested factory stores propagate derived updates inside model instances", async () => {
    function createHeaderModel() {
      const $chat = createStore<{ name: string } | null>(null);
      const $typingUsers = createStore<string[]>([]);
      const chatChanged = createEvent<{ name: string } | null>();
      const typingUsersChanged = createEvent<string[]>();
      const $chatName = $chat.map((chat) => chat?.name ?? "");
      const $chatSubtitle = combine($chat, $typingUsers, (chat, typingUsers) => {
        if (!chat) {
          return "";
        }

        return typingUsers.length > 0 ? "typing..." : chat.name;
      });

      sample({
        clock: chatChanged,
        target: $chat,
      });

      sample({
        clock: typingUsersChanged,
        target: $typingUsers,
      });

      return {
        $chat,
        $typingUsers,
        $chatName,
        $chatSubtitle,
        chatChanged,
        typingUsersChanged,
      };
    }

    const screenModel = model({
      contract: contract({
        lastHeaderTitle: define.store(define.schema<TString>(), ""),
      })(),
      fn: ({ lastHeaderTitle }) => {
        const header = createHeaderModel();

        sample({
          clock: header.$chatName.updates,
          target: lastHeaderTitle,
        });

        return {
          lastHeaderTitle,
          header,
        };
      },
    });

    const scope = fork();

    await createInstances(scope, screenModel.create, [
      {
        id: "screen-1",
        data: { lastHeaderTitle: "" },
      },
    ]);

    await allSettled(
      screenModel.lens.where((entity) => entity.id === "screen-1").header.chatChanged.target(),
      {
        scope,
        params: { name: "General" },
      },
    );

    const instance = scope.getState(screenModel.$instances)["screen-1"];

    expect(instance).toBeDefined();
    expect(instance!["lastHeaderTitle"]).toBe("General");

    const values = withInstanceContext(
      screenModel,
      instance!,
      () => ({
        chatName: screenModel["~api"].header.$chatName.getState(),
        chatSubtitle: screenModel["~api"].header.$chatSubtitle.getState(),
        lastHeaderTitle: screenModel["~api"].lastHeaderTitle.getState(),
      }),
      scope,
    );

    expect(values).toStrictEqual({
      chatName: "General",
      chatSubtitle: "General",
      lastHeaderTitle: "General",
    });

    await allSettled(
      screenModel.lens
        .where((entity) => entity.id === "screen-1")
        .header.typingUsersChanged.target(),
      {
        scope,
        params: ["u1"],
      },
    );

    const nextValues = withInstanceContext(
      screenModel,
      instance!,
      () => ({
        chatSubtitle: screenModel["~api"].header.$chatSubtitle.getState(),
        lastHeaderTitle: screenModel["~api"].lastHeaderTitle.getState(),
      }),
      scope,
    );

    expect(nextValues).toStrictEqual({
      chatSubtitle: "typing...",
      lastHeaderTitle: "General",
    });
  });

  describe("instances", () => {
    test("create instance", async () => {
      const scope = fork();

      await allSettled(todoList.create, {
        scope,
        params: { id: "a", data: { title: "Todo #1", done: false } },
      });

      await allSettled(todoList.create, {
        scope,
        params: { id: "b", data: { title: "Todo #2", done: true } },
      });

      await allSettled(todoList.create, {
        scope,
        params: { id: "c", data: { title: "Todo #3", done: false } },
      });

      expect(scope.getState(todoList.$instances)).toStrictEqual({
        a: { title: "Todo #1", done: false },
        b: { title: "Todo #2", done: true },
        c: { title: "Todo #3", done: false },
      });
    });

    test("remove instance", async () => {
      const scope = fork();

      await createInstances(scope, todoList.create, [
        { id: "a", data: { title: "Todo #1", done: false } },
        { id: "b", data: { title: "Todo #2", done: true } },
        { id: "c", data: { title: "Todo #3", done: false } },
      ]);

      await allSettled(todoList.lens.where((e) => e.id === "a").delete(), {
        scope,
      });

      expect(scope.getState(todoList.$instances)).toStrictEqual({
        b: { title: "Todo #2", done: true },
        c: { title: "Todo #3", done: false },
      });
    });

    test("mass removing instances", async () => {
      const scope = fork();

      await createInstances(scope, todoList.create, [
        { id: "a", data: { title: "Todo #1", done: false } },
        { id: "b", data: { title: "Todo #2", done: true } },
        { id: "c", data: { title: "Todo #3", done: false } },
      ]);

      await allSettled(todoList.lens.where((e) => e.id === "a" || e.id === "b").delete(), {
        scope,
      });

      expect(scope.getState(todoList.$instances)).toStrictEqual({
        c: { title: "Todo #3", done: false },
      });
    });

    test("create several instances with one batch create call", async () => {
      const scope = fork();

      await createInstances(scope, todoList.create, [
        { id: "a", data: { title: "Todo #1", done: false } },
        { id: "b", data: { title: "Todo #2", done: true } },
        { id: "c", data: { title: "Todo #3", done: false } },
      ]);

      expect(scope.getState(todoList.$instances)).toStrictEqual({
        a: { title: "Todo #1", done: false },
        b: { title: "Todo #2", done: true },
        c: { title: "Todo #3", done: false },
      });
    });

    test("delete several instances with one delete call", async () => {
      const scope = fork();

      await createInstances(scope, todoList.create, [
        { id: "a", data: { title: "Todo #1", done: false } },
        { id: "b", data: { title: "Todo #2", done: true } },
        { id: "c", data: { title: "Todo #3", done: false } },
      ]);

      await allSettled(todoList.delete, {
        scope,
        params: ["a", "c"],
      });

      expect(scope.getState(todoList.$instances)).toStrictEqual({
        b: { title: "Todo #2", done: true },
      });
    });

    test("adds and removes aliases for existing instances", async () => {
      const scope = fork();

      await createInstances(scope, counterModel.create, [{ id: "a1", data: { count: 1 } }]);

      await allSettled(counterModel.addAlias, {
        scope,
        params: { aliasId: "a2", instanceId: "a1" },
      });

      expect(scope.getState(counterModel.$aliases)).toStrictEqual({
        a2: "a1",
      });

      await allSettled(counterModel.removeAlias, {
        scope,
        params: "a2",
      });

      expect(scope.getState(counterModel.$aliases)).toStrictEqual({});
    });

    test("cleans aliases when original instance is deleted", async () => {
      const scope = fork();

      await createInstances(scope, counterModel.create, [
        { id: "a1", data: { count: 1 } },
        { id: "b1", data: { count: 2 } },
      ]);

      await allSettled(counterModel.addAlias, {
        scope,
        params: { aliasId: "a2", instanceId: "a1" },
      });

      await allSettled(counterModel.addAlias, {
        scope,
        params: { aliasId: "b2", instanceId: "b1" },
      });

      await allSettled(counterModel.delete, {
        scope,
        params: "a1",
      });

      expect(scope.getState(counterModel.$instances)).toStrictEqual({
        b1: { count: 2 },
      });
      expect(scope.getState(counterModel.$aliases)).toStrictEqual({
        b2: "b1",
      });
    });

    test("deletes original instance when deletion is requested by alias", async () => {
      const scope = fork();

      await createInstances(scope, counterModel.create, [{ id: "a1", data: { count: 1 } }]);

      await allSettled(counterModel.addAlias, {
        scope,
        params: { aliasId: "a2", instanceId: "a1" },
      });

      await allSettled(counterModel.delete, {
        scope,
        params: "a2",
      });

      expect(scope.getState(counterModel.$instances)).toStrictEqual({});
      expect(scope.getState(counterModel.$aliases)).toStrictEqual({});
    });

    test("creating an instance with an existing alias id removes that alias", async () => {
      const scope = fork();

      await createInstances(scope, counterModel.create, [{ id: "a1", data: { count: 1 } }]);

      await allSettled(counterModel.addAlias, {
        scope,
        params: { aliasId: "a2", instanceId: "a1" },
      });

      await allSettled(counterModel.create, {
        scope,
        params: { id: "a2", data: { count: 2 } },
      });

      await allSettled(counterModel.lens.ids("a2").setCount.target(), {
        scope,
        params: 3,
      });

      expect(scope.getState(counterModel.$instances)).toStrictEqual({
        a1: { count: 1 },
        a2: { count: 3 },
      });
      expect(scope.getState(counterModel.$aliases)).toStrictEqual({});
    });
  });

  describe("ref", () => {
    test("add instance", async () => {
      const scope = fork();

      await createInstances(scope, counterModel.create, [
        { id: "a", data: { count: 1 } },
        { id: "b", data: { count: 2 } },
      ]);

      const dashboardModel = createDashboardModel();

      await createInstances(scope, dashboardModel.create, [
        { id: "d1", data: { name: "Dashboard #1" } },
      ]);

      await allSettled(dashboardModel.lens.where((entity) => entity.id === "d1").track.target(), {
        scope,
        params: "a",
      });

      await allSettled(
        dashboardModel.lens.where((entity) => entity.id === "d1").setSelectedCount.target(),
        {
          scope,
          params: 10,
        },
      );

      expect(scope.getState(counterModel.$instances)).toStrictEqual({
        a: { count: 10 },
        b: { count: 2 },
      });
    });

    test("remove instance", async () => {
      const scope = fork();

      await createInstances(scope, counterModel.create, [{ id: "a", data: { count: 1 } }]);

      const dashboardModel = createDashboardModel();

      await createInstances(scope, dashboardModel.create, [
        { id: "d1", data: { name: "Dashboard #1" } },
      ]);

      await allSettled(dashboardModel.lens.where((entity) => entity.id === "d1").track.target(), {
        scope,
        params: "a",
      });

      await allSettled(dashboardModel.lens.where((entity) => entity.id === "d1").untrack.target(), {
        scope,
        params: "a",
      });

      await allSettled(
        dashboardModel.lens.where((entity) => entity.id === "d1").setSelectedCount.target(),
        {
          scope,
          params: 10,
        },
      );

      expect(scope.getState(counterModel.$instances)).toStrictEqual({
        a: { count: 1 },
      });
    });

    test("updates only instances tracked by the current parent", async () => {
      const scope = fork();

      await createInstances(scope, counterModel.create, [
        { id: "a", data: { count: 1 } },
        { id: "b", data: { count: 2 } },
        { id: "c", data: { count: 3 } },
      ]);

      const dashboardModel = createDashboardModel();

      await createInstances(scope, dashboardModel.create, [
        { id: "d1", data: { name: "Dashboard #1" } },
      ]);

      await allSettled(dashboardModel.lens.where((entity) => entity.id === "d1").track.target(), {
        scope,
        params: "a",
      });

      await allSettled(dashboardModel.lens.where((entity) => entity.id === "d1").track.target(), {
        scope,
        params: "c",
      });

      await allSettled(
        dashboardModel.lens.where((entity) => entity.id === "d1").setSelectedCount.target(),
        {
          scope,
          params: 100,
        },
      );

      expect(scope.getState(counterModel.$instances)).toStrictEqual({
        a: { count: 100 },
        b: { count: 2 },
        c: { count: 100 },
      });
    });

    test("stops updating an instance after it is removed from tracked ids", async () => {
      const scope = fork();

      await createInstances(scope, counterModel.create, [
        { id: "a", data: { count: 1 } },
        { id: "b", data: { count: 2 } },
      ]);

      const dashboardModel = createDashboardModel();

      await createInstances(scope, dashboardModel.create, [
        { id: "d1", data: { name: "Dashboard #1" } },
      ]);

      await allSettled(dashboardModel.lens.where((entity) => entity.id === "d1").track.target(), {
        scope,
        params: "a",
      });

      await allSettled(dashboardModel.lens.where((entity) => entity.id === "d1").track.target(), {
        scope,
        params: "b",
      });

      await allSettled(dashboardModel.lens.where((entity) => entity.id === "d1").untrack.target(), {
        scope,
        params: "a",
      });

      await allSettled(
        dashboardModel.lens.where((entity) => entity.id === "d1").setSelectedCount.target(),
        {
          scope,
          params: 50,
        },
      );

      expect(scope.getState(counterModel.$instances)).toStrictEqual({
        a: { count: 1 },
        b: { count: 50 },
      });
    });

    test("tracks ids independently for different parent instances", async () => {
      const scope = fork();

      await createInstances(scope, counterModel.create, [
        { id: "a", data: { count: 1 } },
        { id: "b", data: { count: 2 } },
      ]);

      const dashboardModel = createDashboardModel();

      await createInstances(scope, dashboardModel.create, [
        { id: "d1", data: { name: "Dashboard #1" } },
        { id: "d2", data: { name: "Dashboard #2" } },
      ]);

      await allSettled(dashboardModel.lens.where((entity) => entity.id === "d1").track.target(), {
        scope,
        params: "a",
      });

      await allSettled(dashboardModel.lens.where((entity) => entity.id === "d2").track.target(), {
        scope,
        params: "b",
      });

      await allSettled(
        dashboardModel.lens.where((entity) => entity.id === "d2").setSelectedCount.target(),
        {
          scope,
          params: 20,
        },
      );

      expect(scope.getState(counterModel.$instances)).toMatchObject({
        a: { count: 1 },
        b: { count: 20 },
      });
    });

    test("does not duplicate tracked ref ids when tracking the same id repeatedly", async () => {
      const scope = fork();

      await createInstances(scope, counterModel.create, [
        { id: "a", data: { count: 1 } },
        { id: "b", data: { count: 2 } },
      ]);

      const dashboardModel = createDashboardModel();

      await createInstances(scope, dashboardModel.create, [
        { id: "d1", data: { name: "Dashboard #1" } },
      ]);

      await allSettled(dashboardModel.lens.where((entity) => entity.id === "d1").track.target(), {
        scope,
        params: "a",
      });

      await allSettled(dashboardModel.lens.where((entity) => entity.id === "d1").track.target(), {
        scope,
        params: "a",
      });

      await allSettled(dashboardModel.lens.where((entity) => entity.id === "d1").track.target(), {
        scope,
        params: "a",
      });

      await allSettled(
        dashboardModel.lens.where((entity) => entity.id === "d1").setSelectedCount.target(),
        {
          scope,
          params: 10,
        },
      );

      expect(scope.getState(counterModel.$instances)).toStrictEqual({
        a: { count: 10 },
        b: { count: 2 },
      });

      const counterModelRefId = dashboardModel["~api"].selected["~id"];

      expect(scope.getState(dashboardModel.$instances)).toMatchObject({
        d1: { name: "Dashboard #1", "~refs": { [counterModelRefId]: ["a"] } },
      });
    });

    describe("union ref", () => {
      test("tracks ids per model key", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [{ id: "a", data: { count: 1 } }]);

        await createInstances(scope, flaggedModel.create, [{ id: "f1", data: { score: 2 } }]);

        const dashboardUnionModel = createDashboardUnionModel();

        await createInstances(scope, dashboardUnionModel.create, [
          { id: "d1", data: { name: "Union dashboard" } },
        ]);

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackCounter.target(),
          {
            scope,
            params: "a",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackFlagged.target(),
          {
            scope,
            params: "f1",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").setSelectedValue.target(),
          {
            scope,
            params: 8,
          },
        );

        expect(scope.getState(counterModel.$instances)).toStrictEqual({
          a: { count: 8 },
        });

        expect(scope.getState(flaggedModel.$instances)).toStrictEqual({
          f1: { score: 8 },
        });
      });

      test("updates only tracked variants when match dispatches by union", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [
          { id: "a", data: { count: 1 } },
          { id: "b", data: { count: 2 } },
        ]);

        await createInstances(scope, flaggedModel.create, [
          { id: "f1", data: { score: 3 } },
          { id: "f2", data: { score: 4 } },
        ]);

        const dashboardUnionModel = createDashboardUnionModel();

        await createInstances(scope, dashboardUnionModel.create, [
          { id: "d1", data: { name: "Union dashboard" } },
        ]);

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackCounter.target(),
          {
            scope,
            params: "a",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackFlagged.target(),
          {
            scope,
            params: "f1",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").setSelectedValue.target(),
          {
            scope,
            params: 11,
          },
        );

        expect(scope.getState(counterModel.$instances)).toStrictEqual({
          a: { count: 11 },
          b: { count: 2 },
        });

        expect(scope.getState(flaggedModel.$instances)).toStrictEqual({
          f1: { score: 11 },
          f2: { score: 4 },
        });
      });

      test("stops affecting a variant after it is removed from tracked ids", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [{ id: "a", data: { count: 1 } }]);

        await createInstances(scope, flaggedModel.create, [{ id: "f1", data: { score: 2 } }]);

        const dashboardUnionModel = createDashboardUnionModel();

        await createInstances(scope, dashboardUnionModel.create, [
          { id: "d1", data: { name: "Union dashboard" } },
        ]);

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackCounter.target(),
          {
            scope,
            params: "a",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackFlagged.target(),
          {
            scope,
            params: "f1",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").untrackFlagged.target(),
          {
            scope,
            params: "f1",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").setSelectedValue.target(),
          {
            scope,
            params: 15,
          },
        );

        expect(scope.getState(counterModel.$instances)).toStrictEqual({
          a: { count: 15 },
        });

        expect(scope.getState(flaggedModel.$instances)).toStrictEqual({
          f1: { score: 2 },
        });
      });
    });
  });

  describe("child", () => {
    test("create instance", async () => {
      const scope = fork();
      const listModel = createListModel();
      const childItemsModel = (listModel as any)["~api"].items;

      await createInstances(scope, listModel.create, [{ id: "l1", data: { title: "List #1" } }]);

      await allSettled(listModel.lens.where((entity) => entity.id === "l1").createItem.target(), {
        scope,
        params: { id: "i1", data: { value: 1 } },
      });

      expect(scope.getState(childItemsModel.$instances)).toMatchObject({
        i1: { value: 1 },
      });
    });

    test("remove instance", async () => {
      const scope = fork();
      const listModel = createListModel();
      const childItemsModel = (listModel as any)["~api"].items;

      await createInstances(scope, listModel.create, [{ id: "l1", data: { title: "List #1" } }]);

      await allSettled(listModel.lens.where((entity) => entity.id === "l1").createItem.target(), {
        scope,
        params: { id: "i1", data: { value: 1 } },
      });

      await allSettled(listModel.lens.where((entity) => entity.id === "l1").removeItem.target(), {
        scope,
        params: "i1",
      });

      expect(scope.getState(childItemsModel.$instances)).toStrictEqual({});
    });

    test("keeps child instances hidden outside of a parent context", async () => {
      const scope = fork();
      const listModel = createListModel();
      const childItemsModel = (listModel as any)["~api"].items;

      await createInstances(scope, listModel.create, [{ id: "l1", data: { title: "List #1" } }]);

      await allSettled(childItemsModel.create, {
        scope,
        params: { id: "detached", data: { value: 1 } },
      });

      expect(scope.getState(childItemsModel.$instances)).toStrictEqual({});
      expect(getChildInstancesByParent(scope, listModel, childItemsModel, "l1")).toStrictEqual({});
    });

    test("stores child instances separately for each parent instance", async () => {
      const scope = fork();
      const listModel = createListModel();
      const childItemsModel = (listModel as any)["~api"].items;

      await createInstances(scope, listModel.create, [
        { id: "l1", data: { title: "List #1" } },
        { id: "l2", data: { title: "List #2" } },
      ]);

      await allSettled(listModel.lens.where((entity) => entity.id === "l1").createItem.target(), {
        scope,
        params: { id: "shared", data: { value: 1 } },
      });

      await allSettled(listModel.lens.where((entity) => entity.id === "l2").createItem.target(), {
        scope,
        params: { id: "shared", data: { value: 2 } },
      });

      await allSettled(listModel.lens.where((entity) => entity.id === "l1").items.value.target(), {
        scope,
        params: 10,
      });

      expect(getChildInstancesByParent(scope, listModel, childItemsModel, "l1")).toMatchObject({
        shared: { value: 10 },
      });

      expect(getChildInstancesByParent(scope, listModel, childItemsModel, "l2")).toMatchObject({
        shared: { value: 2 },
      });
    });

    test("updates child units only inside the current parent context", async () => {
      const scope = fork();
      const listModel = createListModel();
      const childItemsModel = (listModel as any)["~api"].items;

      await createInstances(scope, listModel.create, [
        { id: "l1", data: { title: "List #1" } },
        { id: "l2", data: { title: "List #2" } },
      ]);

      await allSettled(listModel.lens.where((entity) => entity.id === "l1").createItem.target(), {
        scope,
        params: { id: "i1", data: { value: 1 } },
      });

      await allSettled(listModel.lens.where((entity) => entity.id === "l2").createItem.target(), {
        scope,
        params: { id: "i2", data: { value: 2 } },
      });

      await allSettled(listModel.lens.where((entity) => entity.id === "l1").items.value.target(), {
        scope,
        params: 7,
      });

      expect(getChildInstancesByParent(scope, listModel, childItemsModel, "l1")).toMatchObject({
        i1: { value: 7 },
      });

      expect(getChildInstancesByParent(scope, listModel, childItemsModel, "l2")).toMatchObject({
        i2: { value: 2 },
      });
    });
  });

  describe("lens", () => {
    describe("model lens", () => {
      test("call instance unit", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [
          { id: "a", data: { count: 1 } },
          { id: "b", data: { count: 2 } },
        ]);

        await allSettled(counterModel.lens.where((entity) => entity.id === "a").setCount.target(), {
          scope,
          params: 7,
        });

        expect(scope.getState(counterModel.$instances)).toMatchObject({
          a: { count: 7 },
          b: { count: 2 },
        });
      });

      test("call ref instance unit", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [
          { id: "a", data: { count: 1 } },
          { id: "b", data: { count: 2 } },
        ]);

        const dashboardModel = createDashboardModel();

        await createInstances(scope, dashboardModel.create, [
          { id: "d1", data: { name: "Dashboard #1" } },
        ]);

        await allSettled(dashboardModel.lens.where((entity) => entity.id === "d1").track.target(), {
          scope,
          params: "b",
        });

        await allSettled(
          dashboardModel.lens.where((entity) => entity.id === "d1").setSelectedCount.target(),
          {
            scope,
            params: 14,
          },
        );

        expect(scope.getState(counterModel.$instances)).toMatchObject({
          a: { count: 1 },
          b: { count: 14 },
        });
      });

      test("call child instance unit", async () => {
        const scope = fork();
        const listModel = createListModel();
        const childItemsModel = (listModel as any)["~api"].items;

        await createInstances(scope, listModel.create, [{ id: "l1", data: { title: "List #1" } }]);

        await allSettled(listModel.lens.where((entity) => entity.id === "l1").createItem.target(), {
          scope,
          params: { id: "i1", data: { value: 1 } },
        });

        await allSettled(
          listModel.lens.where((entity) => entity.id === "l1").setItemsValue.target(),
          {
            scope,
            params: 4,
          },
        );

        expect(scope.getState(childItemsModel.$instances)).toMatchObject({
          i1: { value: 4 },
        });
      });

      test("watch instance unit", async () => {
        const scope = fork();
        const seen: number[] = [];

        counterModel.lens
          .where((entity) => entity.id === "a")
          .count.clock()
          .watch((value) => seen.push(value));

        await createInstances(scope, counterModel.create, [
          { id: "a", data: { count: 1 } },
          { id: "b", data: { count: 2 } },
        ]);

        await allSettled(counterModel.lens.setCount.target(), {
          scope,
          params: 9,
        });

        expect(seen).toStrictEqual([9]);
      });

      test("watch ref instance unit", async () => {
        const scope = fork();
        const seen: number[] = [];
        const dashboardModel = createDashboardModel();
        const dashboardApi = (dashboardModel as any)["~api"];

        dashboardApi.selectedCountChanged.watch((value: number) => seen.push(value));

        await createInstances(scope, counterModel.create, [{ id: "a", data: { count: 1 } }]);

        await createInstances(scope, dashboardModel.create, [
          { id: "d1", data: { name: "Dashboard #1" } },
        ]);

        await allSettled(dashboardModel.lens.where((entity) => entity.id === "d1").track.target(), {
          scope,
          params: "a",
        });

        await allSettled(
          dashboardModel.lens.where((entity) => entity.id === "d1").setSelectedCount.target(),
          {
            scope,
            params: 16,
          },
        );

        expect(seen).toStrictEqual([16]);
      });

      test("watch child instance unit", async () => {
        const scope = fork();
        const seen: number[] = [];
        const listModel = createListModel();

        listModel.lens
          .where((entity) => entity.id === "l1")
          .items.value.clock()
          .watch((value) => seen.push(value));

        await createInstances(scope, listModel.create, [
          { id: "l1", data: { title: "List #1" } },
          { id: "l2", data: { title: "List #2" } },
        ]);

        await allSettled(listModel.lens.where((entity) => entity.id === "l1").createItem.target(), {
          scope,
          params: { id: "i1", data: { value: 1 } },
        });

        await allSettled(listModel.lens.where((entity) => entity.id === "l2").createItem.target(), {
          scope,
          params: { id: "i2", data: { value: 2 } },
        });

        await allSettled(
          listModel.lens.where((entity) => entity.id === "l2").items.value.target(),
          {
            scope,
            params: 4,
          },
        );

        await allSettled(
          listModel.lens.where((entity) => entity.id === "l1").items.value.target(),
          {
            scope,
            params: 9,
          },
        );

        expect(seen).toStrictEqual([9]);
      });

      test("mass calling", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [
          { id: "a", data: { count: 1 } },
          { id: "b", data: { count: 2 } },
          { id: "c", data: { count: 3 } },
        ]);

        await allSettled(counterModel.lens.setCount.target(), {
          scope,
          params: 22,
        });

        expect(scope.getState(counterModel.$instances)).toMatchObject({
          a: { count: 22 },
          b: { count: 22 },
          c: { count: 22 },
        });
      });

      test("mass watching", async () => {
        const scope = fork();
        const seen: number[] = [];

        counterModel.lens.count.clock().watch((value) => seen.push(value));

        await createInstances(scope, counterModel.create, [
          { id: "a", data: { count: 1 } },
          { id: "b", data: { count: 2 } },
          { id: "c", data: { count: 3 } },
        ]);

        await allSettled(counterModel.lens.setCount.target(), {
          scope,
          params: 30,
        });

        expect(seen).toStrictEqual([30, 30, 30]);
      });

      test("limits action to the first matched instance", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [
          { id: "a", data: { count: 1 } },
          { id: "b", data: { count: 2 } },
          { id: "c", data: { count: 3 } },
        ]);

        await allSettled(counterModel.lens.first().setCount.target(), {
          scope,
          params: 40,
        });

        expect(scope.getState(counterModel.$instances)).toMatchObject({
          a: { count: 40 },
          b: { count: 2 },
          c: { count: 3 },
        });
      });

      test("limits action to the last matched instance", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [
          { id: "a", data: { count: 1 } },
          { id: "b", data: { count: 2 } },
          { id: "c", data: { count: 3 } },
        ]);

        await allSettled(counterModel.lens.last().setCount.target(), {
          scope,
          params: 50,
        });

        expect(scope.getState(counterModel.$instances)).toMatchObject({
          a: { count: 1 },
          b: { count: 2 },
          c: { count: 50 },
        });
      });

      test("filters model instances by ids without scanning the whole collection", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [
          { id: "a", data: { count: 1 } },
          { id: "b", data: { count: 2 } },
          { id: "c", data: { count: 3 } },
        ]);

        await allSettled(counterModel.lens.ids("a", "c").setCount.target(), {
          scope,
          params: 60,
        });

        expect(scope.getState(counterModel.$instances)).toMatchObject({
          a: { count: 60 },
          b: { count: 2 },
          c: { count: 60 },
        });
      });

      test("targets model instances by alias ids", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [
          { id: "a1", data: { count: 1 } },
          { id: "b1", data: { count: 2 } },
        ]);

        await allSettled(counterModel.addAlias, {
          scope,
          params: { aliasId: "a2", instanceId: "a1" },
        });

        await allSettled(counterModel.lens.ids("a2").setCount.target(), {
          scope,
          params: 61,
        });

        expect(scope.getState(counterModel.$instances)).toStrictEqual({
          a1: { count: 61 },
          b1: { count: 2 },
        });
      });

      test("matches alias ids in props-based lens predicates", async () => {
        const scope = fork();
        const websocketMessage = createEvent<{ id: string; count: number }>();

        sample({
          clock: websocketMessage,
          target: counterModel.lens
            .props<{ id: string; count: number }>()
            .where((entity, payload) => entity.id === payload.id)
            .setCount.target((payload) => payload.count),
        });

        await createInstances(scope, counterModel.create, [
          { id: "a1", data: { count: 1 } },
          { id: "b1", data: { count: 2 } },
        ]);

        await allSettled(counterModel.addAlias, {
          scope,
          params: { aliasId: "a2", instanceId: "a1" },
        });

        await allSettled(websocketMessage, {
          scope,
          params: { id: "a2", count: 62 },
        });

        expect(scope.getState(counterModel.$instances)).toStrictEqual({
          a1: { count: 62 },
          b1: { count: 2 },
        });
      });

      test("watches model updates through alias ids", async () => {
        const scope = fork();
        const seen: number[] = [];

        counterModel.lens
          .ids("a2")
          .count.clock()
          .watch((value) => seen.push(value));

        await createInstances(scope, counterModel.create, [{ id: "a1", data: { count: 1 } }]);

        await allSettled(counterModel.addAlias, {
          scope,
          params: { aliasId: "a2", instanceId: "a1" },
        });

        await allSettled(counterModel.lens.ids("a1").setCount.target(), {
          scope,
          params: 63,
        });

        expect(seen).toStrictEqual([63]);
      });

      test("creates aliases from a selected lens instance", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [{ id: "a1", data: { count: 1 } }]);

        await allSettled(counterModel.lens.ids("a1").addAlias(), {
          scope,
          params: "a2",
        });

        await allSettled(counterModel.lens.ids("a2").setCount.target(), {
          scope,
          params: 64,
        });

        expect(scope.getState(counterModel.$aliases)).toStrictEqual({
          a2: "a1",
        });
        expect(scope.getState(counterModel.$instances)).toStrictEqual({
          a1: { count: 64 },
        });
      });

      test("recursively exposes nested stores and events in lens api", async () => {
        const scope = fork();
        const seen: number[] = [];

        nestedCounterModel.lens.form.count.clock().watch((value) => {
          seen.push(value);
        });

        await createInstances(scope, nestedCounterModel.create, [
          { id: "a", data: { count: 1 } },
          { id: "b", data: { count: 4 } },
        ]);

        await allSettled(
          nestedCounterModel.lens
            .where((entity) => entity.id === "a")
            .form.actions.setCount.target(),
          {
            scope,
            params: 5,
          },
        );

        await allSettled(
          nestedCounterModel.lens
            .where((entity) => entity.id === "b")
            .form.actions.setCount.target(),
          {
            scope,
            params: 7,
          },
        );

        expect(scope.getState(nestedCounterModel.$instances)).toMatchObject({
          a: { count: 5 },
          b: { count: 7 },
        });
        expect(seen).toEqual([5, 7]);
      });
    });

    describe("union lens", () => {
      test("splits actions by union variants with match", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [
          { id: "a", data: { count: 1 } },
          { id: "b", data: { count: 2 } },
        ]);

        await createInstances(scope, flaggedModel.create, [{ id: "f1", data: { score: 3 } }]);

        const dashboardUnionModel = createDashboardUnionModel();

        await createInstances(scope, dashboardUnionModel.create, [
          { id: "d1", data: { name: "Union dashboard" } },
        ]);

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackCounter.target(),
          {
            scope,
            params: "a",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackFlagged.target(),
          {
            scope,
            params: "f1",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").setSelectedValue.target(),
          {
            scope,
            params: 60,
          },
        );

        expect(scope.getState(counterModel.$instances)).toMatchObject({
          a: { count: 60 },
          b: { count: 2 },
        });

        expect(scope.getState(flaggedModel.$instances)).toStrictEqual({
          f1: { score: 60 },
        });
      });

      test("limits available variants with only", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [{ id: "a", data: { count: 1 } }]);

        await createInstances(scope, flaggedModel.create, [{ id: "f1", data: { score: 3 } }]);

        const dashboardUnionModel = createDashboardUnionModel();

        await createInstances(scope, dashboardUnionModel.create, [
          { id: "d1", data: { name: "Union dashboard" } },
        ]);

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackCounter.target(),
          {
            scope,
            params: "a",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackFlagged.target(),
          {
            scope,
            params: "f1",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").setCounterOnly.target(),
          {
            scope,
            params: 70,
          },
        );

        expect(scope.getState(counterModel.$instances)).toMatchObject({
          a: { count: 70 },
        });

        expect(scope.getState(flaggedModel.$instances)).toStrictEqual({
          f1: { score: 3 },
        });
      });

      test("deletes matched instances across several variants", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [
          { id: "a", data: { count: 1 } },
          { id: "b", data: { count: 2 } },
        ]);

        await createInstances(scope, flaggedModel.create, [
          { id: "f1", data: { score: 3 } },
          { id: "f2", data: { score: 4 } },
        ]);

        const dashboardUnionModel = createDashboardUnionModel();

        await createInstances(scope, dashboardUnionModel.create, [
          { id: "d1", data: { name: "Union dashboard" } },
        ]);

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackCounter.target(),
          {
            scope,
            params: "a",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackFlagged.target(),
          {
            scope,
            params: "f1",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").deleteSelected.target(),
          {
            scope,
            params: undefined,
          },
        );

        expect(scope.getState(counterModel.$instances)).toMatchObject({
          b: { count: 2 },
        });

        expect(scope.getState(flaggedModel.$instances)).toStrictEqual({
          f2: { score: 4 },
        });
      });

      test("limits action to the first matched union entity", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [
          { id: "a", data: { count: 1 } },
          { id: "b", data: { count: 2 } },
        ]);

        await createInstances(scope, flaggedModel.create, [{ id: "f1", data: { score: 3 } }]);

        const dashboardUnionModel = createDashboardUnionModel();

        await createInstances(scope, dashboardUnionModel.create, [
          { id: "d1", data: { name: "Union dashboard" } },
        ]);

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackCounter.target(),
          {
            scope,
            params: "a",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackCounter.target(),
          {
            scope,
            params: "b",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackFlagged.target(),
          {
            scope,
            params: "f1",
          },
        );

        await allSettled(
          dashboardUnionModel.lens
            .where((entity) => entity.id === "d1")
            .setFirstSelectedValue.target(),
          {
            scope,
            params: 80,
          },
        );

        expect(scope.getState(counterModel.$instances)).toMatchObject({
          a: { count: 80 },
          b: { count: 2 },
        });

        expect(scope.getState(flaggedModel.$instances)).toStrictEqual({
          f1: { score: 3 },
        });
      });

      test("limits action to the last matched union entity", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [{ id: "a", data: { count: 1 } }]);

        await createInstances(scope, flaggedModel.create, [
          { id: "f1", data: { score: 3 } },
          { id: "f2", data: { score: 4 } },
        ]);

        const dashboardUnionModel = createDashboardUnionModel();

        await createInstances(scope, dashboardUnionModel.create, [
          { id: "d1", data: { name: "Union dashboard" } },
        ]);

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackCounter.target(),
          {
            scope,
            params: "a",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackFlagged.target(),
          {
            scope,
            params: "f1",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackFlagged.target(),
          {
            scope,
            params: "f2",
          },
        );

        await allSettled(
          dashboardUnionModel.lens
            .where((entity) => entity.id === "d1")
            .setLastSelectedValue.target(),
          {
            scope,
            params: 90,
          },
        );

        expect(scope.getState(counterModel.$instances)).toStrictEqual({
          a: { count: 1 },
        });

        expect(scope.getState(flaggedModel.$instances)).toMatchObject({
          f1: { score: 3 },
          f2: { score: 90 },
        });
      });

      test("keeps sub-lens predicates isolated between match handlers", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [{ id: "a", data: { count: 1 } }]);

        await createInstances(scope, flaggedModel.create, [{ id: "f1", data: { score: 0 } }]);

        const dashboardUnionModel = createDashboardUnionModel();

        await createInstances(scope, dashboardUnionModel.create, [
          { id: "d1", data: { name: "Union dashboard" } },
        ]);

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackCounter.target(),
          {
            scope,
            params: "a",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackFlagged.target(),
          {
            scope,
            params: "f1",
          },
        );

        await allSettled(
          dashboardUnionModel.lens
            .where((entity) => entity.id === "d1")
            .setWithIsolatedMatch.target(),
          {
            scope,
            params: 95,
          },
        );

        expect(scope.getState(counterModel.$instances)).toStrictEqual({
          a: { count: 1 },
        });

        expect(scope.getState(flaggedModel.$instances)).toMatchObject({
          f1: { score: 95 },
        });
      });

      test("filters union instances by unique ids", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [
          { id: "a", data: { count: 1 } },
          { id: "b", data: { count: 2 } },
        ]);

        await createInstances(scope, flaggedModel.create, [{ id: "f1", data: { score: 3 } }]);

        const selection = union({
          counter: counterModel,
          flagged: flaggedModel,
        });
        const selectionLens = selection.lens;

        await allSettled(
          selectionLens
            .ids(selectionLens.uniqueId("counter", "a"), selectionLens.uniqueId("flagged", "f1"))
            .match({
              counter: (counter) => counter.count.target(),
              flagged: (flagged) => flagged.score.target(),
            }),
          {
            scope,
            params: 70,
          },
        );

        expect(scope.getState(counterModel.$instances)).toMatchObject({
          a: { count: 70 },
          b: { count: 2 },
        });

        expect(scope.getState(flaggedModel.$instances)).toMatchObject({
          f1: { score: 70 },
        });
      });
    });

    describe("union where context", () => {
      test("supports ctx.match inside where", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [{ id: "a", data: { count: 1 } }]);

        await createInstances(scope, flaggedModel.create, [{ id: "f1", data: { score: 0 } }]);

        const dashboardUnionModel = createDashboardUnionModel();

        await createInstances(scope, dashboardUnionModel.create, [
          { id: "d1", data: { name: "Union dashboard" } },
        ]);

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackCounter.target(),
          {
            scope,
            params: "a",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackFlagged.target(),
          {
            scope,
            params: "f1",
          },
        );

        await allSettled(
          dashboardUnionModel.lens
            .where((entity) => entity.id === "d1")
            .setMatchedByContext.target(),
          {
            scope,
            params: 101,
          },
        );

        expect(scope.getState(counterModel.$instances)).toMatchObject({
          a: { count: 101 },
        });

        expect(scope.getState(flaggedModel.$instances)).toStrictEqual({
          f1: { score: 0 },
        });
      });

      test("supports ctx.uniqueId inside where", async () => {
        const scope = fork();

        await createInstances(scope, counterModel.create, [{ id: "a", data: { count: 1 } }]);

        await createInstances(scope, flaggedModel.create, [{ id: "f1", data: { score: 2 } }]);

        const dashboardUnionModel = createDashboardUnionModel();

        await createInstances(scope, dashboardUnionModel.create, [
          { id: "d1", data: { name: "Union dashboard" } },
        ]);

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackCounter.target(),
          {
            scope,
            params: "a",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").trackFlagged.target(),
          {
            scope,
            params: "f1",
          },
        );

        await allSettled(
          dashboardUnionModel.lens.where((entity) => entity.id === "d1").setByUniqueId.target(),
          {
            scope,
            params: 111,
          },
        );

        expect(scope.getState(counterModel.$instances)).toMatchObject({
          a: { count: 111 },
        });

        expect(scope.getState(flaggedModel.$instances)).toStrictEqual({
          f1: { score: 2 },
        });
      });
    });
  });
});

const nestedCounterModel = model({
  contract: contract({
    count: define.store(define.schema<TNumber>(), 0),
  })(),
  fn: ({ count }) => {
    const setCount = createEvent<number>();
    const increment = createEvent<void>();

    sample({
      clock: setCount,
      target: count,
    });

    sample({
      clock: increment,
      source: count,
      fn: (value) => value + 1,
      target: count,
    });

    return {
      form: {
        count,
        actions: {
          setCount,
          increment,
        },
      },
    };
  },
});

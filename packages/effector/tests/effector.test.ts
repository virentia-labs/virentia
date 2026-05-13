import { describe, expect, it } from "vitest";
import {
  allSettled,
  attach,
  clearNode,
  combine,
  createApi,
  createDomain,
  createEffect,
  createEvent,
  createNode,
  createStore,
  fork,
  forward,
  hydrate,
  is,
  restore,
  sample,
  scopeBind,
  serialize,
  split,
  withRegion,
} from "../lib";

describe("@virentia/effector compatibility", () => {
  it("connects events and stores through store.on", async () => {
    const inc = createEvent<number>();
    const reset = createEvent();
    const $count = createStore(0)
      .on(inc, (count, amount) => count + amount)
      .reset(reset);
    const values: number[] = [];

    $count.watch((value) => {
      values.push(value);
    });

    inc(2);
    inc(3);
    reset();

    expect($count.getState()).toBe(0);
    expect(values).toEqual([0, 2, 5, 0]);
  });

  it("runs sample with source, clock, filter, fn, and target", async () => {
    const submitted = createEvent<number>();
    const target = createEvent<string>();
    const $enabled = createStore(true);
    const $prefix = createStore("#");
    const values: string[] = [];

    target.watch((value) => {
      values.push(value);
    });

    sample({
      source: { prefix: $prefix, enabled: $enabled },
      clock: submitted,
      filter: ({ enabled }) => enabled,
      fn: ({ prefix }, value) => `${prefix}${value}`,
      target,
    });

    submitted(1);
    $enabled.setState(false);
    submitted(2);

    expect(values).toEqual(["#1"]);
  });

  it("combines stores and updates derived state", () => {
    const firstNameChanged = createEvent<string>();
    const lastNameChanged = createEvent<string>();
    const $firstName = createStore("Ada").on(firstNameChanged, (_, value) => value);
    const $lastName = createStore("Lovelace").on(lastNameChanged, (_, value) => value);
    const $fullName = combine(
      { firstName: $firstName, lastName: $lastName },
      ({ firstName, lastName }) => `${firstName} ${lastName}`,
    );

    firstNameChanged("Grace");
    lastNameChanged("Hopper");

    expect($fullName.getState()).toBe("Grace Hopper");
  });

  it("filters store updates with updateFilter", () => {
    const moveTo = createEvent<{ x: number; y: number }>();
    const values: Array<{ x: number; y: number }> = [];
    const $position = createStore(
      { x: 0, y: 0 },
      {
        updateFilter: (next, current) => next.x !== current.x || next.y !== current.y,
      },
    ).on(moveTo, (_, next) => next);

    $position.updates.watch((value) => {
      values.push(value);
    });

    moveTo({ x: 1, y: 1 });
    moveTo({ x: 1, y: 1 });
    moveTo({ x: 1, y: 2 });

    expect(values).toEqual([
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ]);
  });

  it("samples effect calls as clock params", async () => {
    const triggerFx = createEffect<number, string>((value) => `fx:${value}`);
    const target = createEvent<number>();
    const values: number[] = [];

    target.watch((value) => {
      values.push(value);
    });

    sample({
      clock: triggerFx,
      target,
    });

    await triggerFx(7);

    expect(values).toEqual([7]);
  });

  it("isolates state with fork and allSettled", async () => {
    const inc = createEvent<number>();
    const $count = createStore(0).on(inc, (count, amount) => count + amount);
    const firstScope = fork();
    const secondScope = fork({ values: [[$count, 10]] });

    await allSettled(inc, { scope: firstScope, params: 2 });
    await allSettled(inc, { scope: secondScope, params: 5 });

    expect($count.getState()).toBe(0);
    expect(firstScope.getState($count)).toBe(2);
    expect(secondScope.getState($count)).toBe(15);
  });

  it("uses handlers from fork scope", async () => {
    const requestFx = createEffect<number, string>({
      sid: "request-fx",
      handler: (id) => `real:${id}`,
    });
    const $results = createStore<string[]>([]).on(requestFx.doneData, (list, value) => [
      ...list,
      value,
    ]);
    const scope = fork({
      handlers: {
        "request-fx": (id: number) => `mock:${id}`,
      },
    });

    const result = await allSettled(requestFx, { scope, params: 1 });

    expect(result).toEqual({ status: "done", value: "mock:1" });
    expect(scope.getState($results)).toEqual(["mock:1"]);
    expect(await requestFx(2)).toBe("real:2");
  });

  it("accepts domain as fork and hydrate target", async () => {
    const app = createDomain();
    const add = app.createEvent<number>();
    const requestFx = app.createEffect<number, number>({
      sid: "domain-request-fx",
      handler: () => 0,
    });
    const $count = app
      .createStore(0, { sid: "domain-count" })
      .on(add, (count, amount) => count + amount);

    sample({
      clock: requestFx.doneData,
      target: add,
    });

    const scope = fork(app, {
      values: [[$count, 10]],
      handlers: [[requestFx, () => 5]],
    });

    await allSettled(requestFx, { scope, params: 1 });
    expect(scope.getState($count)).toBe(15);
    expect($count.getState()).toBe(0);

    hydrate(app, {
      values: [[$count, 7]],
    });

    expect($count.getState()).toBe(7);
  });

  it("passes attached effect source to scoped handlers", async () => {
    const $token = createStore("root", { sid: "handler-token" });
    const sendFx = attach({
      source: $token,
      async effect(_token: string, _message: { text: string }) {},
    });
    const calls: unknown[] = [];
    const scope = fork({
      values: [[$token, "scoped"]],
      handlers: [
        [
          sendFx,
          (token: string, message: { text: string }) => {
            calls.push({ token, message });
          },
        ],
      ],
    });

    await allSettled(sendFx, {
      scope,
      params: { text: "hello" },
    });

    expect(calls).toEqual([{ token: "scoped", message: { text: "hello" } }]);
  });

  it("creates effects with use and exposes effect subunits", async () => {
    const fetchFx = createEffect<number, string>();
    const values: unknown[] = [];

    fetchFx.use(async (id) => `user:${id}`);
    fetchFx.doneData.watch((value) => {
      values.push(value);
    });

    const result = await fetchFx(1);

    expect(result).toBe("user:1");
    expect(values).toEqual(["user:1"]);
    expect(fetchFx.pending.getState()).toBe(false);
    expect(fetchFx.inFlight.getState()).toBe(0);
  });

  it("uses effect params in store reducers", async () => {
    const saveFx = createEffect<string, string>((name) => name.toUpperCase());
    const $name = createStore("alice").on(saveFx, (_, name) => name);

    await saveFx("bob");

    expect($name.getState()).toBe("bob");
  });

  it("resets stores from spread units", () => {
    const set = createEvent<number>();
    const resetA = createEvent();
    const resetB = createEvent();
    const $count = createStore(0)
      .on(set, (_, value) => value)
      .reset(resetA, resetB);

    set(1);
    resetA();
    set(2);
    resetB();

    expect($count.getState()).toBe(0);
  });

  it("clears links created inside withRegion", () => {
    const trigger = createEvent();
    const target = createEvent<number>();
    const $source = createStore(0);
    const region = createNode();
    const values: number[] = [];

    target.watch((value) => {
      values.push(value);
    });

    withRegion(region, () => {
      sample({
        clock: trigger,
        source: $source,
        target,
      });
    });

    trigger();
    clearNode(region);
    trigger();

    expect(values).toEqual([0]);
  });

  it("clears units created inside withRegion", () => {
    const region = createNode();
    const values: number[] = [];
    const regional = withRegion(region, () => createEvent<number>());

    regional.watch((value) => {
      values.push(value);
    });

    regional(1);
    clearNode(region);
    regional(2);

    expect(values).toEqual([1]);
  });

  it("forwards store updates without the initial state", () => {
    const inc = createEvent();
    const $count = createStore(0).on(inc, (value) => value + 1);
    const target = createEvent<number>();
    const values: number[] = [];

    target.watch((value) => {
      values.push(value);
    });
    forward({
      from: $count,
      to: target,
    });

    inc();

    expect(values).toEqual([1]);
  });

  it("routes payloads with split", () => {
    const submitted = createEvent<number>();
    const routed = split(submitted, {
      even: (value) => value % 2 === 0,
      odd: (value) => value % 2 === 1,
    });
    const values: string[] = [];

    routed.even.watch((value) => {
      values.push(`even:${value}`);
    });
    routed.odd.watch((value) => {
      values.push(`odd:${value}`);
    });

    submitted(1);
    submitted(2);

    expect(values).toEqual(["odd:1", "even:2"]);
  });

  it("supports createApi and restore helpers", () => {
    const submitted = createEvent<string>();
    const $value = restore(submitted, "initial");
    const api = createApi($value, {
      upper: (value) => value.toUpperCase(),
      append: (value, suffix: string) => `${value}${suffix}`,
    });

    submitted("virentia");
    api.upper();
    api.append("!");

    expect($value.getState()).toBe("VIRENTIA!");
  });

  it("creates attached effects from source stores", async () => {
    const requestFx = createEffect<{ token: string; id: number }, string>();
    const $token = createStore("root", { sid: "attach-token" });
    const scopedRequestFx = attach({
      source: $token,
      effect: requestFx,
      mapParams: (id: number, token: string) => ({ token, id }),
    });
    const scope = fork({ values: { "attach-token": "scoped" } });

    requestFx.use(({ token, id }) => `${token}:${id}`);

    const result = await allSettled(scopedRequestFx, { scope, params: 7 });

    expect(result).toEqual({ status: "done", value: "scoped:7" });
    expect(await scopedRequestFx(1)).toBe("root:1");
  });

  it("runs attached effect through the source effect lifecycle", async () => {
    const requestFx = createEffect<number, { value: number }>((value) => ({ value }));
    const attachedFx = attach({
      effect: requestFx,
      mapParams: (word: string) => word.length,
    });
    const calls: unknown[] = [];

    requestFx.watch((params) => {
      calls.push(["request.watch", params]);
    });
    requestFx.done.watch(({ params, result }) => {
      calls.push(["request.done", params, result.value]);
    });
    attachedFx.watch((params) => {
      calls.push(["attached.watch", params]);
    });
    attachedFx.done.watch(({ params, result }) => {
      calls.push(["attached.done", params, result.value]);
    });

    await expect(attachedFx("test")).resolves.toEqual({ value: 4 });

    expect(calls).toEqual(
      expect.arrayContaining([
        ["attached.watch", "test"],
        ["request.watch", 4],
        ["request.done", 4, 4],
        ["attached.done", "test", 4],
      ]),
    );
  });

  it("serializes and hydrates scoped store values by sid", async () => {
    const inc = createEvent<number>();
    const $count = createStore(0, { sid: "serialize-count" }).on(
      inc,
      (count, amount) => count + amount,
    );
    const $name = createStore("Ada", { sid: "serialize-name" });
    const scope = fork();

    await allSettled(inc, { scope, params: 3 });
    hydrate(scope, { values: { "serialize-name": "Grace" } });

    expect(serialize(scope)).toEqual({
      "serialize-count": 3,
      "serialize-name": "Grace",
    });
    expect(serialize(scope, { ignore: [$name] })).toEqual({
      "serialize-count": 3,
    });

    const hydratedScope = fork();

    hydrate(hydratedScope, { values: serialize(scope) });

    expect(hydratedScope.getState($count)).toBe(3);
    expect(hydratedScope.getState($name)).toBe("Grace");
  });

  it("skips stores with serialize ignore", async () => {
    const inc = createEvent();
    const $visible = createStore(0, { sid: "visible-store" }).on(inc, (count) => count + 1);
    const $secret = createStore("token", {
      sid: "secret-store",
      serialize: "ignore",
    });
    const scope = fork({
      values: [[$secret, "scoped-token"]],
    });

    await allSettled(inc, { scope });

    expect(serialize(scope)).toEqual({
      "visible-store": 1,
    });
    expect(scope.getState($visible)).toBe(1);
    expect(scope.getState($secret)).toBe("scoped-token");
    hydrate(scope, { values: { "secret-store": "hydrated-token" } });
    expect(scope.getState($secret)).toBe("hydrated-token");
  });

  it("registers units in domain history and hooks", async () => {
    const domain = createDomain("app");
    const units: unknown[] = [];

    domain.onCreateEvent((unit) => units.push(["event", unit.shortName]));
    domain.onCreateEffect((unit) => units.push(["effect", unit.shortName]));
    domain.onCreateStore((unit) => units.push(["store", unit.shortName]));
    domain.onCreateDomain((unit) => units.push(["domain", unit.getType()]));

    const changed = domain.createEvent<number>("changed");
    const requestFx = domain.createEffect<number, string>({
      name: "request",
      handler: (value) => `ok:${value}`,
    });
    const $value = domain.createStore(0, { name: "value" }).on(changed, (_, value) => value);
    const child = domain.createDomain("child");

    expect(domain.getType()).toBe("app");
    expect(child.getType()).toBe("app/child");
    expect(domain.history.events.has(changed)).toBe(true);
    expect(domain.history.effects.has(requestFx)).toBe(true);
    expect(domain.history.stores.has($value)).toBe(true);
    expect(domain.history.domains.has(child)).toBe(true);
    expect(units).toEqual([
      ["event", "changed"],
      ["effect", "request"],
      ["store", "value"],
      ["domain", "app/child"],
    ]);
    await expect(requestFx(1)).resolves.toBe("ok:1");
  });

  it("uses domain ownership for derived helpers and clearNode", () => {
    const domain = createDomain();
    const units: unknown[] = [];
    const values: number[] = [];

    domain.onCreateEvent((unit) => units.push(["event", unit.shortName]));
    domain.onCreateStore((unit) => units.push(["store", unit.shortName]));

    const changed = domain.createEvent<number>("changed");
    const $value = restore(changed, 0);
    const api = createApi($value, {
      add: (value, amount: number) => value + amount,
    });

    $value.watch((value) => values.push(value));
    changed(1);
    api.add(2);
    clearNode(domain);
    changed(10);
    api.add(20);

    expect(units).toEqual([
      ["event", "changed"],
      ["store", "store"],
      ["event", "add"],
    ]);
    expect(values).toEqual([0, 1, 3]);
  });

  it("exposes scopeBind and is utilities", async () => {
    const add = createEvent<number>();
    const saveFx = createEffect<number, string>((value) => `saved:${value}`);
    const $count = createStore(0).on(add, (count, amount) => count + amount);
    const scope = fork();
    const boundAdd = scopeBind(add, { scope });

    await (boundAdd(5) as Promise<void>);

    expect(scope.getState($count)).toBe(5);
    expect(is.unit(add)).toBe(true);
    expect(is.event(add)).toBe(true);
    expect(is.store($count)).toBe(true);
    expect(is.effect(saveFx)).toBe(true);
    expect(is.targetable(add)).toBe(true);
    expect(is.targetable($count)).toBe(true);
    expect(is.targetable(saveFx)).toBe(true);
    expect(is.targetable(saveFx.pending)).toBe(false);
    expect(is.store(add)).toBe(false);
    expect(is.targetable({})).toBe(false);
  });
});

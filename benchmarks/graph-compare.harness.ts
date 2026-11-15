import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { event, reaction, scope, scoped, store, type Store } from "@virentia/core";
import { computed, observable, runInAction } from "mobx";
import {
  allSettled,
  combine as effectorCombine,
  createEvent,
  createStore,
  fork,
  type Store as EffectorStore,
} from "effector";

// Same width/depth/update sequence as graph.harness.ts, now with controls.
// Includes each library's completion boundary, not only mapper function time.
const width = 8,
  depth = 3,
  warmup = 200,
  updates = 2000;
const variant = process.argv[2];
const observed = process.argv[3] === "observed";
const extraInput = process.argv.includes("extra");
let computations = 0;
interface Graph {
  tick(): unknown;
  read(): number;
  independentRead(): number;
}

function virentiaGraph(): Graph {
  const app = scope(),
    tick = event();
  const sources = Array.from({ length: width }, () => store(0));
  const rate = store(1);
  const terminals = sources.map((source) => {
    let current: Store<number> = source;
    for (let level = 0; level < depth; level++) {
      const delta = level + 1;
      current = current.map((value) => {
        computations++;
        return value + delta + (extraInput ? rate.value : 0);
      });
    }
    return current;
  });
  reaction({
    on: tick,
    run() {
      for (const source of sources) source.value++;
    },
  });
  const read = (home = app) =>
    scoped(home, () => terminals.reduce((sum, terminal) => sum + terminal.value, 0));
  if (observed) for (const terminal of terminals) terminal.subscribe(() => {});
  return { tick: () => scoped(app, () => tick()), read, independentRead: () => read(scope()) };
}

function mobxGraph(): Graph {
  const create = () => {
    const sources = Array.from({ length: width }, () => observable.box(0));
    const rate = observable.box(1);
    const terminals = sources.map((source) => {
      let current: { get(): number } = source;
      for (let level = 0; level < depth; level++) {
        const previous = current,
          delta = level + 1;
        current = computed(
          () => {
            computations++;
            return previous.get() + delta + (extraInput ? rate.get() : 0);
          },
          { keepAlive: true },
        );
      }
      return current;
    });
    return {
      tick: () =>
        runInAction(() => {
          for (const source of sources) source.set(source.get() + 1);
        }),
      read: () => terminals.reduce((sum, terminal) => sum + terminal.get(), 0),
    };
  };
  return { ...create(), independentRead: () => create().read() };
}

function effectorGraph(): Graph {
  const tick = createEvent();
  const sources = Array.from({ length: width }, () =>
    createStore(0).on(tick, (value) => value + 1),
  );
  const rate = createStore(1);
  const terminals = sources.map((source) => {
    let current: EffectorStore<number> = source;
    for (let level = 0; level < depth; level++) {
      const delta = level + 1;
      const mapper = (value: number, rateValue = 0) => {
        computations++;
        return value + delta + rateValue;
      };
      current = extraInput ? effectorCombine(current, rate, mapper) : current.map(mapper);
    }
    return current;
  });
  const app = fork();
  const read = (home = app) =>
    terminals.reduce((sum, terminal) => sum + home.getState(terminal), 0);
  return {
    tick: () => allSettled(tick, { scope: app }),
    read,
    independentRead: () => read(fork()),
  };
}

const graph =
  variant === "virentia"
    ? virentiaGraph()
    : variant === "mobx"
      ? mobxGraph()
      : variant === "effector"
        ? effectorGraph()
        : undefined;
if (observed && variant !== "virentia")
  throw Error("Observed mode is a Virentia regression guard only");
if (!graph || !global.gc) throw Error("Pass virentia/mobx/effector and --expose-gc");
for (let index = 0; index < warmup; index++) {
  await graph.tick();
  graph.read();
}
for (let index = 0; index < 5; index++) global.gc();
const profileTag = process.env.AUDIT_GRAPH_CPU_TAG;
const session = profileTag ? new Session() : undefined;
if (session) {
  if (!/^[a-z0-9-]+$/i.test(profileTag!)) throw Error("Invalid profile tag");
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 100 });
  await session.post("Profiler.start");
}
computations = 0;
let checksum = 0;
const started = performance.now();
for (let index = 0; index < updates; index++) {
  await graph.tick();
  checksum += graph.read();
}
const elapsedMs = performance.now() - started;
if (session) {
  const { profile } = await session.post("Profiler.stop");
  writeFileSync(
    new URL(`graph-${profileTag}.cpuprofile`, import.meta.url),
    JSON.stringify(profile),
  );
  session.disconnect();
}
const measuredComputations = computations;
const delta = (depth * (depth + 1)) / 2 + (extraInput ? depth : 0);
assert.equal(checksum, width * (updates * (warmup + delta) + (updates * (updates + 1)) / 2));
assert.equal(graph.read(), width * (warmup + updates + delta));
assert.equal(measuredComputations, width * depth * updates);
assert.equal(
  computations,
  measuredComputations,
  "A repeated read must use retained computed caches",
);
assert.equal(graph.independentRead(), width * delta);
console.log(
  JSON.stringify({
    variant,
    observed,
    extraInput,
    width,
    depth,
    warmup,
    updates,
    elapsedMs,
    checksum,
    computations: measuredComputations,
    checked: true,
  }),
);

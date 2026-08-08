import { describe, expect, it, vi } from "vitest";
import { event, reaction, scope, scoped, store } from "../../lib/index";
import { collection, f, model, refs, staticModel } from "../../lib/models";

// §10.4: `onCleanup` on instances — external subscriptions (sockets, markers,
// unsubscribes) tie to the INSTANCE's lifetime in both kinds, with no store
// and no per-instance units. Dynamic setups additionally get owner-attached
// cleanup of unit subscriptions for free.

function app<T>(fn: () => T): T {
  return scoped(scope(), fn) as T;
}

describe("dynamic model: subscriptions made in setup", () => {
  it("a store subscription created in setup is auto-cleaned on dispose", () => {
    const external = store(0);
    const seen: number[] = [];

    const Probe: any = model({
      data: { label: f.string("") },
      setup() {
        external.subscribe((value) => {
          seen.push(value as number);
        });
      },
    });

    app(() => {
      const probes: any = collection(Probe);
      const probe = probes.add({});

      external.value = 1;

      expect(seen).toEqual([1]);

      probes.remove(probe.id);

      external.value = 2; // the instance owner is disposed — no delivery

      expect(seen).toEqual([1]);
    });
  });

  it("self.onCleanup works right in the setup body", () => {
    const closed: string[] = [];

    const Session: any = model({
      data: { host: f.string("") },
      setup(self: any) {
        // an external resource created per instance
        const socket = { close: () => closed.push(self.host.value) };

        self.onCleanup(() => socket.close());
      },
    });

    app(() => {
      const sessions: any = collection(Session);
      const session = sessions.add({ host: "a.example" });

      sessions.add({ host: "b.example" });

      expect(closed).toEqual([]);

      session.dispose();

      expect(closed).toEqual(["a.example"]); // only this instance's cleanup, fields still readable
    });
  });
});

describe("static model: per-instance external cleanups without stores", () => {
  it("a unit body subscribes externally and ties the unsubscribe to the ambient instance", async () => {
    const topics = new Map<string, Set<(m: string) => void>>();
    const subscribeTopic = (topic: string, listener: (m: string) => void) => {
      let bucket = topics.get(topic);

      if (!bucket) topics.set(topic, (bucket = new Set()));

      bucket.add(listener);

      return () => bucket!.delete(listener);
    };

    const Ticker: any = staticModel({
      data: { symbol: f.string(""), last: f.string("").local() },
      setup(self: any) {
        const connect = event<void>();

        reaction({
          on: connect,
          run: () => {
            // ambient instance — the unsubscribe belongs to IT (§10.4)
            self.onCleanup(
              subscribeTopic(self.symbol.value, (message) => {
                self.last.value = message;
              }),
            );
          },
        });

        return { connect };
      },
    });

    await app(async () => {
      const tickers: any = collection(Ticker);
      const btc = tickers.add({ symbol: "BTC" });
      const eth = tickers.add({ symbol: "ETH" });

      await btc.connect();
      await eth.connect();

      expect(topics.get("BTC")!.size).toBe(1);
      expect(topics.get("ETH")!.size).toBe(1);

      tickers.remove(btc.id);

      expect(topics.get("BTC")!.size).toBe(0); // only BTC's subscription died
      expect(topics.get("ETH")!.size).toBe(1);
    });
  });

  it("facade onCleanup attaches outside resources; unregister works", () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });
    const cleaned = vi.fn();
    const detached = vi.fn();

    app(() => {
      const todos: any = collection(Todo);
      const t = todos.add({ title: "x" });

      t.onCleanup(cleaned);

      const unregister = t.onCleanup(detached);

      unregister();

      todos.remove(t.id);

      expect(cleaned).toHaveBeenCalledTimes(1);
      expect(detached).not.toHaveBeenCalled();
    });
  });

  it("cleanups run while the instance is still readable", () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });
    let readDuringCleanup: string | null = null;

    app(() => {
      const todos: any = collection(Todo);
      const t = todos.add({ title: "still here" });

      t.onCleanup(() => {
        readDuringCleanup = t.title.value;
      });

      todos.remove(t.id);
    });

    expect(readDuringCleanup).toBe("still here");
  });
});

describe("edges", () => {
  it("a throwing cleanup is reported and does not abort disposal", () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = vi.fn();

    app(() => {
      const todos: any = collection(Todo);
      const t = todos.add({});

      t.onCleanup(() => {
        throw new Error("boom");
      });
      t.onCleanup(second);

      todos.remove(t.id);

      expect(second).toHaveBeenCalledTimes(1);
      expect(todos.count).toBe(0);
      expect(t.alive).toBe(false);
    });

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("restrict aborts the dispose BEFORE cleanups run", () => {
    const Todo: any = staticModel({ data: { title: f.string("") }, name: "todo" });
    const Pin: any = staticModel({
      data: { target: (refs.one(Todo) as any).policy("restrict") },
      name: "pin",
    });
    const cleaned = vi.fn();

    app(() => {
      const todos: any = collection(Todo);
      const pins: any = collection(Pin);
      const t = todos.add({});
      const pin: any = pins.add({});

      pin.target.value = t;
      t.onCleanup(cleaned);

      expect(() => todos.remove(t.id)).toThrowError(/restrict/);
      expect(cleaned).not.toHaveBeenCalled(); // the instance survived intact

      pin.target.value = null;
      todos.remove(t.id);

      expect(cleaned).toHaveBeenCalledTimes(1);
    });
  });

  it("a pooled scope does not inherit the previous occupant's cleanups", async () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });
    const cleaned = vi.fn();

    await app(async () => {
      const todos: any = collection(Todo);
      const first = todos.add({});

      first.onCleanup(cleaned);
      todos.remove(first.id);

      expect(cleaned).toHaveBeenCalledTimes(1);

      await Promise.resolve(); // the scope joins the pool

      const second = todos.add({}); // reuses the slot

      todos.remove(second.id);

      expect(cleaned).toHaveBeenCalledTimes(1); // not re-run for the next occupant
    });
  });

  it("registering on a disposed instance throws the disposed error", () => {
    const Todo: any = staticModel({ data: { title: f.string("") } });

    app(() => {
      const todos: any = collection(Todo);
      const t = todos.add({});

      todos.remove(t.id);

      expect(() => t.onCleanup(() => {})).toThrowError(/disposed/);
    });
  });
});

describe("static model resource patterns (docs contract)", () => {
  it("a self write AFTER await in a reaction lands on the ambient instance", async () => {
    const Search: any = staticModel({
      data: { query: f.string(""), result: f.string("").local() },
      setup(self: any) {
        const run = event<void>();

        reaction({
          on: run,
          run: async () => {
            const query = self.query.value;

            await Promise.resolve(); // scope restoration must keep the instance

            self.result.value = `found:${query}`;
          },
        });

        return { run };
      },
    });

    await app(async () => {
      const searches: any = collection(Search);
      const a = searches.add({ query: "alpha" });
      const b = searches.add({ query: "beta" });

      await a.run();
      await b.run();

      expect(a.result.value).toBe("found:alpha");
      expect(b.result.value).toBe("found:beta");
    });
  });

  it("a local field is the per-instance slot: latest-wins abort + abort on dispose", async () => {
    const aborted: string[] = [];

    const makeController = (tag: string) => ({
      tag,
      done: false,
      abort() {
        // real AbortController.abort() is idempotent - mirror that
        if (!this.done) {
          this.done = true;
          aborted.push(this.tag);
        }
      },
    });

    const Job: any = staticModel({
      data: { label: f.string(""), inFlight: f.any(null).local() },
      setup(self: any) {
        const start = event<string>();

        reaction({
          on: start,
          run: (tag) => {
            self.inFlight.value?.abort(); // latest wins — supersede the previous run

            const controller = makeController(`${self.label.value}:${tag}`);

            self.inFlight.value = controller;
            self.onCleanup(() => controller.abort()); // dispose aborts the in-flight one
          },
        });

        return { start };
      },
    });

    await app(async () => {
      const jobs: any = collection(Job);
      const a = jobs.add({ label: "a" });
      const b = jobs.add({ label: "b" });

      await a.start("first");
      await a.start("second"); // supersedes a:first
      await b.start("only");

      expect(aborted).toEqual(["a:first"]);

      jobs.remove(a.id); // aborts a:second, leaves b alone

      expect(aborted).toEqual(["a:first", "a:second"]);

      jobs.remove(b.id);

      expect(aborted).toEqual(["a:first", "a:second", "b:only"]);
    });
  });
});

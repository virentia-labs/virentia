import { afterEach, describe, expect, it, vi } from "vitest";
import {
  effect,
  event,
  reaction,
  scope,
  scoped,
  setErrorReporter,
  store,
  type VirentiaFailureReport,
} from "../../lib";
import { flush, resetActiveScope } from "../support/scope-helpers";

// An event's reactions run straight from its propagation when nothing else is
// queued. Everything below is what the queued path does; the direct one must
// do the same.
afterEach(() => {
  setErrorReporter(null);
  resetActiveScope();
  vi.restoreAllMocks();
});

describe("reactions run straight from an event", () => {
  it("commit the writes of every reaction together", () => {
    const app = scope();
    const a = store(0),
      b = store(0);
    const tick = event<number>();
    const seen: string[] = [];
    reaction({ on: tick, run: (value) => void (a.value = value) });
    reaction({ on: tick, run: (value) => void (b.value = value * 10) });
    a.subscribe((value) => seen.push(`a=${value} b=${scoped(app, () => b.value)}`));
    scoped(app, () => tick(2));
    expect(seen).toEqual(["a=2 b=20"]);
  });

  it("run every reaction once a reaction before them fails, and reject the call", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const received: VirentiaFailureReport[] = [];
    setErrorReporter((failure) => received.push(failure));
    const app = scope();
    const tick = event<number>({ name: "tick" });
    const ran: string[] = [];
    const failure = new Error("first");
    reaction({
      name: "first",
      on: tick,
      run: () => {
        ran.push("first");
        throw failure;
      },
    });
    reaction({ name: "second", on: tick, run: () => void ran.push("second") });
    await expect(scoped(app, () => tick(1))).rejects.toBe(failure);
    expect(ran).toEqual(["first", "second"]);
    expect(received).toHaveLength(1);
    expect(received[0].error).toBe(failure);
    expect(received[0].path).toEqual(['event "tick"', 'reaction "first"']);
  });

  it("let a reporter's own call queue behind the remaining reactions", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = scope();
    const tick = event<number>();
    const reported = event<void>();
    const ran: string[] = [];
    reaction({ on: reported, run: () => void ran.push("reported") });
    setErrorReporter(() => {
      // It joins the failing drain, so it rejects with the failure too.
      reported().catch(() => {});
    });
    reaction({
      on: tick,
      run: () => {
        ran.push("first");
        throw new Error("first");
      },
    });
    reaction({ on: tick, run: () => void ran.push("second") });
    scoped(app, () => tick(1)).catch(() => {});
    expect(ran).toEqual(["first", "second", "reported"]);
  });

  it("park an asynchronous reaction and run the ones after it once it settles", async () => {
    const app = scope();
    const tick = event<number>();
    const ran: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    reaction({
      on: tick,
      run: async () => {
        ran.push("async start");
        await gate;
        ran.push("async end");
      },
    });
    reaction({ on: tick, run: () => void ran.push("after") });
    const done = scoped(app, () => tick(1));
    expect(ran).toEqual(["async start"]);
    release();
    await done;
    expect(ran).toEqual(["async start", "async end", "after"]);
  });

  it("run the reactions the event had when it fired", () => {
    const app = scope();
    const tick = event<number>();
    const ran: string[] = [];
    let second: { stop(): void } | undefined;
    reaction({
      on: tick,
      run: (value) => {
        ran.push(`first ${value}`);
        second?.stop();
        if (value === 1) reaction({ on: tick, run: (later) => void ran.push(`late ${later}`) });
      },
    });
    second = reaction({ on: tick, run: (value) => void ran.push(`second ${value}`) });
    scoped(app, () => tick(1));
    scoped(app, () => tick(2));
    expect(ran).toEqual(["first 1", "first 2", "late 2"]);
  });

  it("run a nested call's reactions inside the reaction that calls it", () => {
    const app = scope();
    const outer = event<number>(),
      inner = event<number>();
    const ran: string[] = [];
    const count = store(0);
    count.subscribe((value) => ran.push(`count ${value}`));
    reaction({ on: inner, run: (value) => void ran.push(`inner ${value}`) });
    reaction({
      on: outer,
      run: (value) => {
        ran.push("outer start");
        void inner(value);
        count.value = value;
        ran.push("outer end");
      },
    });
    reaction({ on: outer, run: () => void ran.push("outer second") });
    scoped(app, () => outer(3));
    expect(ran).toEqual(["outer start", "inner 3", "outer end", "outer second", "count 3"]);
  });

  it("run a call from a reaction before the reactions after that one", () => {
    const app = scope();
    const first = event<number>(),
      second = event<number>();
    const ran: string[] = [];
    reaction({
      on: first,
      run: (value) => {
        ran.push("first a");
        void second(value);
      },
    });
    reaction({ on: first, run: () => void ran.push("first b") });
    reaction({ on: second, run: () => void ran.push("second") });
    scoped(app, () => first(1));
    expect(ran).toEqual(["first a", "second", "first b"]);
  });

  it("skip a reaction bound to another scope", () => {
    const app = scope(),
      other = scope();
    const tick = event<number>();
    const ran: string[] = [];
    reaction({ scope: other, on: tick, run: () => void ran.push("other") });
    reaction({ on: tick, run: () => void ran.push("global") });
    scoped(app, () => tick(1));
    scoped(other, () => tick(1));
    expect(ran).toEqual(["global", "other", "global"]);
  });

  it("let a reaction await an effect in the event's scope", async () => {
    const app = scope();
    const tick = event<number>();
    const doubled = effect(async (value: number) => value * 2);
    const result = store(0);
    reaction({
      on: tick,
      run: async (value) => {
        result.value = await doubled(value);
      },
    });
    await scoped(app, () => tick(4));
    await flush();
    expect(scoped(app, () => result.value)).toBe(8);
  });
});

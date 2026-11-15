import { describe, expect, it, vi } from "vitest";
import { event, reaction, scope, scoped, store } from "../../lib";
import {
  node,
  registerSynchronousSink,
  registerSynchronousMethodSink,
  reconcileScopedEdges,
} from "../../lib/internal";
import { onInspectorEvent } from "../../lib/kernel/inspector";

describe("isolated synchronous sinks", () => {
  it("shares a prototype registration while guarding an overridden instance run", () => {
    const value = store(0),
      app = scope();
    class Sink {
      #seen: number[] = [];
      run() {
        this.#seen.push(value.value);
      }
      get seen() {
        return this.#seen;
      }
    }
    registerSynchronousMethodSink(Sink.prototype);
    const first = Object.freeze(new Sink());
    reconcileScopedEdges(app, first, [value.node]);
    const sourceRun = vi.spyOn(value.node, "run");
    scoped(app, () => {
      value.value = 1;
    });
    expect(first.seen).toEqual([1]);
    expect(sourceRun).not.toHaveBeenCalled();
    const second = new Sink(),
      other = scope();
    const replacement = vi.fn();
    second.run = replacement;
    reconcileScopedEdges(other, second, [value.node]);
    scoped(other, () => {
      value.value = 2;
    });
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(sourceRun).toHaveBeenCalledTimes(1);
    expect(first.seen).toEqual([1]);
  });

  it.each([false, true])(
    "retains prototype receivers, including frozen method sinks (%s)",
    (frozen) => {
      const value = store(0),
        app = scope();
      class Sink {
        #seen: number[] = [];
        run() {
          this.#seen.push(value.value);
        }
        get seen() {
          return this.#seen;
        }
      }
      const sink = new Sink();
      if (frozen) Object.freeze(sink);
      registerSynchronousMethodSink(sink);
      reconcileScopedEdges(app, sink, [value.node]);
      const run = vi.spyOn(value.node, "run");
      scoped(app, () => {
        value.value = 1;
      });
      expect(sink.seen).toEqual([1]);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("still accepts frozen function sinks and invalidates a replaced prototype run", () => {
    const value = store(0),
      app = scope();
    const update = vi.fn();
    const sink = Object.freeze(node({ run: update }));
    registerSynchronousSink(sink, update);
    reconcileScopedEdges(app, sink, [value.node]);
    scoped(app, () => {
      value.value = 1;
    });
    expect(update).toHaveBeenCalledTimes(1);
    const other = store(0),
      otherScope = scope();
    const original = vi.fn(),
      replacement = vi.fn();
    const method = { run: original };
    registerSynchronousMethodSink(method);
    reconcileScopedEdges(otherScope, method, [other.node]);
    method.run = replacement;
    const sourceRun = vi.spyOn(other.node, "run");
    scoped(otherScope, () => {
      other.value = 1;
    });
    expect(original).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(sourceRun).toHaveBeenCalledTimes(1);
  });
  it("updates a terminal sink synchronously without traversing the source node", () => {
    const value = store(0),
      app = scope();
    const seen: number[] = [];
    const update = () => {
      seen.push(value.value);
    };
    const sink = node({ run: update });
    registerSynchronousSink(sink, update);
    reconcileScopedEdges(app, sink, [value.node]);
    const run = vi.spyOn(value.node, "run");
    scoped(app, () => {
      value.value = 1;
    });
    expect(seen).toEqual([1]);
    expect(run).not.toHaveBeenCalled();
  });

  it("uses the full graph with other observers, nested drains and inspection", async () => {
    const value = store(0),
      app = scope();
    const seen: number[] = [];
    const update = () => {
      seen.push(value.value);
    };
    const sink = node({ run: update, priority: 2 });
    registerSynchronousSink(sink, update);
    reconcileScopedEdges(app, sink, [value.node]);
    const run = vi.spyOn(value.node, "run");
    const observer = reaction({
      on: value,
      scope: app,
      run: () => {
        seen.push(-value.value);
      },
    });
    scoped(app, () => {
      value.value = 1;
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([-1, 1]);
    observer.stop();
    const change = event();
    const changeReaction = reaction({
      on: change,
      run: () => {
        value.value = 2;
      },
    });
    await scoped(app, () => change());
    expect(run).toHaveBeenCalledTimes(2);
    changeReaction.stop();
    const events: string[] = [];
    const off = onInspectorEvent((event) => {
      if ("node" in event && event.node === sink) events.push(event.type);
    });
    try {
      scoped(app, () => {
        value.value = 3;
      });
    } finally {
      off();
    }
    expect(run).toHaveBeenCalledTimes(3);
    expect(events).toContain("node-start");
    expect(events).toContain("node-end");
  });

  it("does not reuse a sink's fast path if it gains downstream dependencies", () => {
    const value = store(0),
      app = scope();
    const update = vi.fn();
    const sink = node({ run: update });
    const dependent = vi.fn();
    registerSynchronousSink(sink, update);
    reconcileScopedEdges(app, sink, [value.node]);
    reconcileScopedEdges(app, node({ run: dependent }), [sink]);
    scoped(app, () => {
      value.value = 1;
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(dependent).toHaveBeenCalledTimes(1);
  });
});

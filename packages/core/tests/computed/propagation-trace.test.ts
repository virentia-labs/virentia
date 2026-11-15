import { describe, expect, it, vi } from "vitest";
import { computed, event, getCurrentScope, reaction, scope, scoped, store } from "../../lib";
import { getInspectorNodeId, onInspectorEvent, setInspectorBreakpoints } from "../../lib/kernel/inspector";

describe("computed propagation traces", () => {
  it("publishes the settled diamond once across multiple inputs and an equal result", async () => {
    const app = scope();
    const source = store(0), offset = store(0);
    const parity = source.map((value) => value % 2);
    const scaled = source.map((value) => value * 10 + offset.value);
    const total = computed(() => parity.value + scaled.value);
    const change = event<[number, number]>();
    const trace: string[] = [];
    const writer = reaction({ on: change, run([value, extra]) {
      trace.push(`write:${value}:${extra}`);
      source.value = value;
      offset.value = extra;
    } });
    expect(scoped(app, () => total.value)).toBe(0);
    const unsubscribe = total.subscribe((value) => trace.push(`notify:${value}`));
    try {
      for (const input of [[1, 5], [3, 5], [4, -4]] as [number, number][]) {
        await scoped(app, () => change(input));
        trace.push(`settled:${scoped(app, () => total.value)}`);
      }
      expect(trace).toEqual([
        "write:1:5", "notify:16", "settled:16",
        "write:3:5", "notify:36", "settled:36",
        "write:4:-4", "settled:36",
      ]);
    } finally {
      unsubscribe();
      writer.stop();
    }
  });

  it("finishes sibling notifications before publishing a subscriber's write in another application", () => {
    const first = scope(), second = scope(), source = store(0);
    const terminal = source.map((value) => value + 1).map((value) => value * 2);
    expect(scoped(first, () => terminal.value)).toBe(2);
    expect(scoped(second, () => terminal.value)).toBe(2);
    const trace: string[] = [];
    const name = (home: typeof first) => home === first ? "first" : "second";
    const offFirst = terminal.subscribe((value, home) => {
      trace.push(`A:${name(home)}:${value}:${source.value}`);
      if (home === first) scoped(second, () => { source.value = 5; });
    });
    const offSecond = terminal.subscribe((value, home) => {
      trace.push(`B:${name(home)}:${value}:${source.value}`);
    });
    try {
      scoped(first, () => { source.value = 1; });
      expect(trace).toEqual([
        "A:first:4:1", "B:first:4:1", "A:second:12:5", "B:second:12:5",
      ]);
      expect(scoped(first, () => terminal.value)).toBe(4);
      expect(scoped(second, () => terminal.value)).toBe(12);
    } finally {
      offFirst();
      offSecond();
    }
  });

  it("awaits a computed result before propagating it without repeating the mapper", async () => {
    const app = scope(), source = store(0), change = event();
    const trace: string[] = [];
    let release!: (value: number) => void;
    const pending = new Promise<number>((resolve) => { release = resolve; });
    const mapped = source.map((value) => {
      trace.push(`map:${value}`);
      return value ? pending : Promise.resolve(0);
    });
    await scoped(app, () => mapped.value);
    const writer = reaction({ on: change, run() { source.value = 1; } });
    const observer = reaction({ on: mapped, run(value) {
      trace.push(`reaction:${String(value)}:${getCurrentScope() === app}`);
    } });
    const unsubscribe = mapped.subscribe((value) => trace.push(`subscriber:${value === pending}`));
    trace.length = 0;
    try {
      const completion = scoped(app, () => change());
      expect(trace).toEqual(["map:1", "subscriber:true"]);
      release(7);
      await completion;
      expect(trace).toEqual(["map:1", "subscriber:true", "reaction:7:true"]);
      scoped(app, () => { expect(mapped.value).toBe(pending); });
    } finally {
      release(7);
      unsubscribe();
      observer.stop();
      writer.stop();
    }
  });

  it("honours an installed breakpoint before publishing a computed result", () => {
    const app = scope(), source = store(0), trace: string[] = [];
    let stopInspector: (() => void) | undefined;
    const mapped = source.map((value) => value * 2);
    const terminal = mapped.map((value) => value + 1);
    const unsubscribe = terminal.subscribe((value) => trace.push(`notify:${value}`));
    try {
      expect(scoped(app, () => terminal.value)).toBe(1);
      stopInspector = onInspectorEvent((entry) => {
        if (entry.type === "breakpoint-hit" && entry.node === mapped.node) trace.push("breakpoint");
      });
      setInspectorBreakpoints([getInspectorNodeId(mapped.node)]);
      scoped(app, () => { source.value = 1; });
      expect(trace).toEqual(["breakpoint"]);
      // A breakpoint stops pushed notifications. An explicit read still pulls
      // the latest inputs through the lazy graph.
      expect(scoped(app, () => terminal.value)).toBe(3);
      setInspectorBreakpoints([]);
      stopInspector?.();
      scoped(app, () => { source.value = 2; });
      expect(trace).toEqual(["breakpoint", "notify:5"]);
    } finally {
      setInspectorBreakpoints([]);
      stopInspector?.();
      unsubscribe();
    }
  });

  it("stops a rejected computed result and resumes propagation on a later update", async () => {
    const app = scope(), source = store(0), change = event<number>();
    const failure = new Error("computed result failed");
    let reject!: (reason: unknown) => void;
    const pending = new Promise<number>((_resolve, no) => { reject = no; });
    const mapped = source.map((value) => value === 1 ? pending : Promise.resolve(value));
    await scoped(app, () => mapped.value);
    const seen: string[] = [];
    const writer = reaction({ on: change, run(value) { source.value = value; } });
    const observer = reaction({ on: mapped, run(value) { seen.push(String(value)); } });
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const completion = scoped(app, () => change(1));
      reject(failure);
      await expect(completion).rejects.toBe(failure);
      expect(seen).toEqual([]);
      expect(report).toHaveBeenCalledWith(expect.any(String), failure);
      await scoped(app, () => change(2));
      expect(seen).toEqual(["2"]);
    } finally {
      report.mockRestore();
      observer.stop();
      writer.stop();
    }
  });

  it("honours a custom runner accessor without relying on the number of scheduler probes", () => {
    const app = scope(), source = store(0);
    const mapped = source.map((value) => value + 1);
    const terminal = mapped.map((value) => value * 2);
    expect(scoped(app, () => terminal.value)).toBe(2);
    const descriptor = Object.getOwnPropertyDescriptor(mapped.node, "run")!;
    const original = mapped.node.run!;
    const wrapper = vi.fn(original);
    let probes = 0;
    Object.defineProperty(mapped.node, "run", {
      configurable: true,
      get() { probes++; return wrapper; },
    });
    try {
      scoped(app, () => { source.value = 1; });
      expect(wrapper).toHaveBeenCalledTimes(1);
      expect(probes).toBeGreaterThan(0);
      expect(scoped(app, () => terminal.value)).toBe(4);
    } finally {
      if (descriptor) Object.defineProperty(mapped.node, "run", descriptor);
      else Reflect.deleteProperty(mapped.node, "run");
    }
  });

  it("runs a then membership probe's nested event before returning to that probe", async () => {
    const app = scope(), source = store(0), change = event(), nested = event();
    const trace: string[] = [];
    const resolved = Promise.resolve(7);
    const then = resolved.then.bind(resolved);
    let probed = false;
    const pending = new Proxy(resolved, {
      has(target, key) {
        if (key === "then" && !probed) {
          probed = true;
          trace.push("then:before");
          void nested();
          trace.push("then:after");
        }
        return Reflect.has(target, key);
      },
      get(target, key, receiver) {
        return key === "then" ? then : Reflect.get(target, key, receiver);
      },
    });
    const mapped = source.map((value) => value === 1 ? pending : Promise.resolve(value));
    await scoped(app, () => mapped.value);
    const writer = reaction({ on: change, run() { source.value = 1; } });
    const nestedObserver = reaction({ on: nested, run() { trace.push("nested"); } });
    const observer = reaction({ on: mapped, run(value) { trace.push(`value:${String(value)}`); } });
    try {
      await scoped(app, () => change());
      expect(trace).toEqual(["then:before", "nested", "then:after", "value:7"]);
    } finally {
      writer.stop();
      nestedObserver.stop();
      observer.stop();
    }
  });
});

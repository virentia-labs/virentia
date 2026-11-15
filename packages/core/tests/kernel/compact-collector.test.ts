import { expect, it } from "vitest";
import { scope, scoped } from "../../lib";
import { node } from "../../lib/internal";
import {
  collectNodes,
  collectNodeSources,
  collectNodeSourcesInto,
  collectScopedNodes,
  trackNode,
} from "../../lib/graph/deps";
import type { Node } from "../../lib/kernel";

it("publishes reusable source output after nested compact reads", () => {
  const a = node(),
    b = node();
  const capture: { source?: Node; nodes?: Set<Node> } = {};
  const value = collectNodeSourcesInto(() => {
    trackNode(a);
    expect(
      collectNodeSourcesInto(() => {
        trackNode(b);
        return 2;
      }, capture),
    ).toBe(2);
    expect(capture.source).toBe(b);
    trackNode(a);
    return 3;
  }, capture);
  expect(value).toBe(3);
  expect(capture.source).toBe(a);
  expect(capture.nodes).toBeUndefined();
});

it("restores full collectors when reusable-output readers throw", () => {
  const a = node(),
    b = node();
  const capture: { source?: Node; nodes?: Set<Node> } = {};
  const outer = collectNodes(() => {
    trackNode(a);
    expect(() =>
      collectNodeSourcesInto(() => {
        trackNode(b);
        throw new Error("read failed");
      }, capture),
    ).toThrow("read failed");
    trackNode(a);
  });
  expect(outer.nodes).toEqual(new Set([a]));
});

it("clears obsolete fan-in output and never probes a returned thenable", () => {
  const a = node(),
    b = node();
  const capture: { source?: Node; second?: Node; nodes?: Set<Node> } = {};
  // Two sources are kept without a set; a third makes one.
  collectNodeSourcesInto(() => {
    trackNode(a);
    trackNode(b);
  }, capture);
  expect([capture.source, capture.second, capture.nodes]).toEqual([a, b, undefined]);
  const c = node();
  collectNodeSourcesInto(() => {
    trackNode(a);
    trackNode(b);
    trackNode(a);
    trackNode(c);
  }, capture);
  expect(capture.nodes).toEqual(new Set([a, b, c]));
  expect(capture.second).toBeUndefined();
  let probes = 0;
  const value = new Proxy(
    {},
    {
      has() {
        probes++;
        return false;
      },
    },
  );
  expect(collectNodeSourcesInto(() => value, capture)).toBe(value);
  expect(capture.source).toBeUndefined();
  expect(capture.second).toBeUndefined();
  expect(capture.nodes).toBeUndefined();
  expect(probes).toBe(0);
});

it("preserves zero-argument reads", () => {
  const app = scope();
  const read = collectScopedNodes(app, function () {
    expect(arguments.length).toBe(0);
    return 1;
  });
  expect(read.value).toBe(1);
});

it("keeps result shapes and leaves returned thenables untouched", () => {
  let probes = 0;
  const value = new Proxy(
    {},
    {
      has() {
        probes++;
        return false;
      },
    },
  );
  const full = collectNodes(() => value);
  const compact = collectNodeSources(() => value);
  expect(Object.keys(full)).toEqual(["result", "nodes"]);
  expect(Object.keys(compact)).toEqual(["result", "source", "nodes"]);
  expect(full.result).toBe(value);
  expect(compact.result).toBe(value);
  expect(probes).toBe(0);
});

it("keeps zero and repeated single-source reads compact and promotes distinct fan-in", () => {
  const a = node(),
    b = node();
  const empty = collectNodeSources(() => 1);
  expect(empty).toMatchObject({ result: 1, source: undefined, nodes: undefined });
  const single = collectNodeSources(() => {
    trackNode(a);
    trackNode(a);
    return 2;
  });
  expect(single.result).toBe(2);
  expect(single.source).toBe(a);
  expect(single.nodes).toBeUndefined();
  const many = collectNodeSources(() => {
    trackNode(a);
    trackNode(b);
    trackNode(a);
    return 3;
  });
  expect(many.result).toBe(3);
  expect([...many.nodes!]).toEqual([a, b]);
});

it("restores the parent collector after nested reads and failures", () => {
  const a = node(),
    b = node(),
    c = node();
  const outer = collectNodes(() => {
    trackNode(a);
    const inner = collectNodeSources(() => {
      trackNode(b);
      return "inner";
    });
    expect(inner.source).toBe(b);
    expect(() =>
      collectNodeSources(() => {
        trackNode(b);
        throw Error("read failed");
      }),
    ).toThrow("read failed");
    trackNode(c);
  });
  expect([...outer.nodes]).toEqual([a, c]);
});

it("does not leak nested computed dependencies into a scoped UI-style read", () => {
  const app = scope(),
    inside = node(),
    outside = node();
  const captured = scoped(app, () =>
    collectScopedNodes(app, () => {
      const nested = collectNodeSources(() => {
        trackNode(inside);
        return 1;
      });
      trackNode(outside);
      return nested;
    }),
  );
  expect(captured.value.source).toBe(inside);
  expect([...captured.dependencies]).toEqual([outside]);
});

it("restores nested compact frames across fan-in, full collectors and throws", () => {
  const a = node(),
    b = node(),
    c = node();
  const outer = collectNodeSources(() => {
    trackNode(a);
    const inner = collectNodeSources(() => {
      trackNode(b);
      trackNode(c);
      expect(() =>
        collectNodeSources(() => {
          trackNode(a);
          throw Error("nested failure");
        }),
      ).toThrow("nested failure");
      trackNode(b);
    });
    expect([...inner.nodes!]).toEqual([b, c]);
    expect([...collectNodes(() => trackNode(b)).nodes]).toEqual([b]);
    trackNode(a);
    return 1;
  });
  expect(outer.source).toBe(a);
  expect(outer.nodes).toBeUndefined();
  expect(outer.result).toBe(1);
  expect(collectNodeSources(() => trackNode(c)).source).toBe(c);
});

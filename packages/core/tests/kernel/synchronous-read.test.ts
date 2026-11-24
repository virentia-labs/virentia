import { expect, it } from "vitest";
import { computed, effect, scope, scoped, store } from "../../lib";
import {
  collectScopedNodes,
  isTracking,
  node,
  reconcileScopedSource,
  registerSynchronousSink,
} from "../../lib/internal";

it("captures only direct reads and keeps nested captures independent", () => {
  const app = scope(), left = store(1), right = store(2);
  let nested!: ReturnType<typeof collectScopedNodes<number>>;
  const outer = scoped(app, () => collectScopedNodes(app, () => {
    nested = collectScopedNodes(app, () => right.value);
    return left.value + left.value;
  }));
  expect(outer.value).toBe(2);
  expect(outer.dependencies).toEqual(new Set([left.node]));
  expect(nested.dependencies).toEqual(new Set([right.node]));
  expect(scoped(app, () => isTracking())).toBe(false);
});

it("does not turn an empty capture into a later capture's dependency set", () => {
  const app = scope(), source = store(1);
  scoped(app, () => {
    const first = collectScopedNodes(app, () => 0);
    const second = collectScopedNodes(app, () => source.value);
    expect(first.dependencies.size).toBe(0);
    expect(second.dependencies).toEqual(new Set([source.node]));
  });
});

it("observes a computed without leaking its implementation reads", () => {
  const app = scope(), source = store(1), doubled = computed(() => source.value * 2);
  const captured = scoped(app, () => collectScopedNodes(app, () => doubled.value));
  expect(captured.value).toBe(2);
  expect(captured.dependencies).toEqual(new Set([doubled.node]));
});

it("excludes a called effect's synchronous reads", async () => {
  const app = scope(), visible = store(1), hidden = store(2);
  const readHidden = effect(() => hidden.value);
  let captured!: ReturnType<typeof collectScopedNodes<number>>;
  await scoped(app, async () => {
    captured = collectScopedNodes(app, () => { void readHidden(); return visible.value; });
  });
  expect(captured.dependencies).toEqual(new Set([visible.node]));
});

it("excludes explicit scoped bodies even when their application scope is identical", () => {
  const app = scope(), visible = store(1), hidden = store(2);
  const captured = scoped(app, () => collectScopedNodes(app, () => {
    const value = scoped(app, () => hidden.value);
    return visible.value + value;
  }));
  expect(captured.value).toBe(3);
  expect(captured.dependencies).toEqual(new Set([visible.node]));
});

it("excludes synchronous terminal consumers triggered by a write during capture", () => {
  const app = scope(), visible = store(1), hidden = store(2), trigger = store(0);
  let ran = 0;
  const consume = () => { ran++; void hidden.value; };
  const observer = node({ run: consume });
  reconcileScopedSource(app, observer, trigger.node);
  registerSynchronousSink(observer, consume);
  const captured = scoped(app, () => collectScopedNodes(app, () => {
    trigger.value = 1;
    return visible.value;
  }));
  expect(ran).toBe(1);
  expect(captured.dependencies).toEqual(new Set([visible.node]));
});

it("honours a renderer's nested callback boundary", () => {
  const app = scope(), visible = store(1), hidden = store(2), boundary = { depth: 0 };
  const captured = scoped(app, () => collectScopedNodes(app, () => {
    boundary.depth++;
    void hidden.value;
    boundary.depth--;
    return visible.value;
  }, boundary));
  expect(captured.dependencies).toEqual(new Set([visible.node]));
});

it("restores an outer capture after a nested read throws", () => {
  const app = scope(), visible = store(1), hidden = store(2);
  const captured = scoped(app, () => collectScopedNodes(app, () => {
    expect(() => collectScopedNodes(app, () => { void hidden.value; throw Error("read failed"); })).toThrow("read failed");
    return visible.value;
  }));
  expect(captured.dependencies).toEqual(new Set([visible.node]));
  expect(scoped(app, () => isTracking())).toBe(false);
});

it("restores scope, renderer boundaries and accumulated dependencies independently", () => {
  const app = scope(), other = scope(), left = store(1), right = store(2), hidden = store(3);
  const outerBoundary = { depth: 0 }, nestedBoundary = { depth: 4 };
  let nested!: ReturnType<typeof collectScopedNodes<number>>;
  const captured = scoped(app, () => collectScopedNodes(app, () => {
    void left.value;
    scoped(other, () => {
      nested = collectScopedNodes(other, () => right.value, nestedBoundary);
      expect(() => collectScopedNodes(other, () => {
        void hidden.value;
        throw Error("inner failed");
      }, nestedBoundary)).toThrow("inner failed");
    });
    outerBoundary.depth++;
    void hidden.value;
    outerBoundary.depth--;
    return left.value;
  }, outerBoundary));
  expect(captured.dependencies).toEqual(new Set([left.node]));
  expect(nested.dependencies).toEqual(new Set([right.node]));
  expect(scoped(app, () => isTracking())).toBe(false);
  expect(scoped(other, () => isTracking())).toBe(false);
  expect(scoped(app, () => collectScopedNodes(app, () => 0).dependencies.size)).toBe(0);
});

it("keeps dependencies first discovered while preparing a nested boundary", () => {
  const app = scope(), left = store(1), right = store(2);
  let initialized = false;
  const boundary = {
    get depth() {
      if (!initialized) {
        initialized = true;
        void left.value;
      }
      return 0;
    },
  };
  let nested!: ReturnType<typeof collectScopedNodes<number>>;
  const outer = scoped(app, () => collectScopedNodes(app, () => {
    nested = collectScopedNodes(app, () => right.value, boundary);
    return nested.value;
  }));
  expect(outer.dependencies).toEqual(new Set([left.node]));
  expect(nested.dependencies).toEqual(new Set([right.node]));
  expect(outer.value).toBe(2);
});

it("restores its parent when preparing a nested boundary re-enters another scope", () => {
  const app = scope(), other = scope(), left = store(1), right = store(2), hidden = store(3);
  let initialized = false;
  const boundary = {
    get depth() {
      if (!initialized) {
        initialized = true;
        scoped(other, () => collectScopedNodes(other, () => hidden.value));
        void left.value;
      }
      return 0;
    },
  };
  const outer = scoped(app, () => collectScopedNodes(app, () => {
    collectScopedNodes(app, () => right.value, boundary);
    return left.value;
  }));
  expect(outer.dependencies).toEqual(new Set([left.node]));
  expect(scoped(app, () => isTracking())).toBe(false);
  expect(scoped(other, () => isTracking())).toBe(false);
});

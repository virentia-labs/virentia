import { expect, it, vi } from "vitest";
import {
  cleanupResource,
  lifetime,
  lifetimeContains,
  ownCleanup,
  ownDOMNode,
  ownResource,
} from "../lib/lifetime";

it("keeps sibling lifecycle order after removing first, middle and last children", async () => {
  const parent = lifetime(),
    order: string[] = [];
  const children = Array.from({ length: 5 }, (_, index) => {
    const child = lifetime(parent);
    child.beforeDispose(() => {
      order.push(`before:${index}`);
    });
    child.onCleanup(() => {
      order.push(`after:${index}`);
    });
    return child;
  });
  await children[2].dispose();
  await children[0].dispose();
  await children[4].dispose();
  const extra = lifetime(parent),
    nested = lifetime(children[1]);
  expect(lifetimeContains(parent, nested)).toBe(true);
  expect(lifetimeContains(children[1], nested)).toBe(true);
  expect(lifetimeContains(children[3], nested)).toBe(false);
  expect(lifetimeContains(parent, children[2])).toBe(false);
  extra.beforeDispose(() => {
    order.push("before:extra");
  });
  extra.onCleanup(() => {
    order.push("after:extra");
  });
  order.length = 0;
  await parent.dispose();
  expect(order).toEqual([
    "before:1",
    "before:3",
    "before:extra",
    "after:extra",
    "after:3",
    "after:1",
  ]);
  expect(lifetimeContains(parent, nested)).toBe(false);
});

it("retains duplicate protection when public cleanups follow uniquely created nodes", async () => {
  const owner = lifetime(),
    order: unknown[] = [];
  const nodes = Array.from({ length: 25 }, () => ({}) as Node);
  const remove = (node: Node) => {
    order.push(node);
  };
  for (const node of nodes) ownDOMNode(owner, node, remove, true);
  ownDOMNode(owner, nodes[4], remove);
  const callback = () => {
    order.push("callback");
  };
  owner.onCleanup(callback);
  owner.onCleanup(callback);
  const resource = {
    [cleanupResource]() {
      order.push("resource");
    },
  };
  ownResource(owner, resource, true);
  ownResource(owner, resource);
  await owner.dispose();
  expect(order).toEqual(["resource", "callback", ...nodes.slice().reverse()]);
  ownDOMNode(owner, nodes[0], remove, true);
  expect(order.at(-1)).toBe(nodes[0]);
});

it("preserves deduplication, cancellation and reverse order after cleanup promotion", async () => {
  const owner = lifetime(),
    seen: number[] = [];
  const callbacks = Array.from({ length: 20 }, (_, index) => () => {
    seen.push(index);
  });
  const cancels = callbacks.map((callback) => owner.onCleanup(callback));
  owner.onCleanup(callbacks[0]);
  ownCleanup(owner, callbacks[19]);
  cancels[4]();
  cancels[4]();
  cancels[12]();
  await owner.dispose();
  expect(seen).toEqual(
    Array.from({ length: 20 }, (_, index) => 19 - index).filter(
      (index) => index !== 4 && index !== 12,
    ),
  );
});

it("supports detached lifetime methods and idempotent async teardown", async () => {
  const parent = lifetime(),
    child = lifetime(parent);
  const { dispose, onCleanup, beforeDispose } = parent;
  const cleaned = vi.fn();
  const order: string[] = [];
  let finish!: () => void;
  beforeDispose(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
        order.push("before");
      }),
  );
  onCleanup(() => {
    cleaned();
    order.push("parent");
  });
  child.onCleanup(() => {
    order.push("child");
  });
  expect(lifetimeContains(parent, child)).toBe(true);
  const pending = dispose();
  expect(dispose()).toBe(pending);
  expect(parent.closing).toBe(true);
  expect(parent.closed).toBe(false);
  expect(cleaned).not.toHaveBeenCalled();
  finish();
  await pending;
  expect(order).toEqual(["before", "child", "parent"]);
  expect(parent.disposed).toBe(true);
  expect(lifetimeContains(parent, child)).toBe(false);
  onCleanup(cleaned);
  expect(cleaned).toHaveBeenCalledTimes(2);
});

it("interleaves node disposal with callbacks in reverse registration order", async () => {
  const owner = lifetime();
  const first = {} as Node,
    second = {} as Node;
  const seen: unknown[] = [];
  const remove = (node: Node) => {
    seen.push(node);
  };
  ownDOMNode(owner, first, remove);
  owner.onCleanup(() => {
    seen.push("between");
  });
  ownDOMNode(owner, second, remove);
  const cancel = owner.onCleanup(() => {
    throw new Error("cancelled");
  });
  cancel();
  await owner.dispose();
  expect(seen).toEqual([second, "between", first]);
  ownDOMNode(owner, first, remove);
  expect(seen).toEqual([second, "between", first, first]);
});

it("keeps internal cleanups ordered and accepts them while async teardown is pending", async () => {
  const owner = lifetime();
  const order: string[] = [];
  let release!: () => void;
  owner.beforeDispose(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  ownCleanup(owner, () => {
    order.push("first");
  });
  owner.onCleanup(() => {
    order.push("public");
  });
  const closing = owner.dispose();
  ownCleanup(owner, () => {
    order.push("during");
  });
  expect(order).toEqual([]);
  release();
  await closing;
  expect(order).toEqual(["during", "public", "first"]);
  ownCleanup(owner, () => {
    order.push("closed");
  });
  expect(order).toEqual(["during", "public", "first", "closed"]);
});

it("cleans resource objects in place, deduplicated and interleaved with DOM and callbacks", async () => {
  const owner = lifetime(),
    order: string[] = [];
  const resource = Object.freeze({
    [cleanupResource]() {
      expect(this).toBe(resource);
      order.push("resource");
    },
  });
  ownDOMNode(owner, {} as Node, () => {
    order.push("node");
  });
  ownResource(owner, resource);
  ownResource(owner, resource);
  ownCleanup(owner, () => {
    order.push("callback");
  });
  await owner.dispose();
  expect(order).toEqual(["callback", "resource", "node"]);
  ownResource(owner, resource);
  expect(order).toEqual(["callback", "resource", "node", "resource"]);
});

it.each([3, 6, 7, 12])("keeps the teardown snapshot during reentrant cancellation (%i cleanups)", async (count) => {
  const owner = lifetime();
  const order: number[] = [];
  const cancels = Array.from({ length: count }, (_, index) =>
    owner.onCleanup(() => {
      order.push(index);
    }),
  );
  owner.onCleanup(() => {
    // This must not cancel a callback that is already in the teardown snapshot.
    cancels[0]();
    owner.onCleanup(() => {
      order.push(count);
    });
    ownResource(owner, {
      [cleanupResource]() {
        order.push(count + 1);
      },
    });
    throw new Error("cleanup failed");
  });
  await expect(owner.dispose()).rejects.toThrow("[ui] Unmount failed");
  expect(order).toEqual([
    count,
    count + 1,
    ...Array.from({ length: count }, (_, index) => count - index - 1),
  ]);
});

it("settles a synchronous teardown for reentrant and later callers alike", async () => {
  const parent = lifetime(),
    child = lifetime(parent);
  const order: string[] = [];
  let reentrant: Promise<void> | undefined;
  child.beforeDispose(() => {
    // The group is mid-teardown: this caller waits for all of it.
    reentrant = child.dispose();
    void reentrant.then(() => order.push("reentrant settled"));
  });
  child.onCleanup(() => {
    order.push("child cleaned");
  });
  const done = parent.dispose();
  expect(order).toEqual(["child cleaned"]);
  await done;
  await reentrant;
  expect(order).toEqual(["child cleaned", "reentrant settled"]);
  await expect(parent.dispose()).resolves.toBeUndefined();
  await expect(child.dispose()).resolves.toBeUndefined();

  const failing = lifetime();
  failing.onCleanup(() => {
    throw new Error("cleanup failed");
  });
  await expect(failing.dispose()).rejects.toThrow("[ui] Unmount failed");
  await expect(failing.dispose()).rejects.toThrow("[ui] Unmount failed");
});

it("waits for a child that is already closing on its own", async () => {
  const parent = lifetime(),
    child = lifetime(parent);
  const order: string[] = [];
  let release!: () => void;
  child.beforeDispose(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  child.onCleanup(() => {
    order.push("child");
  });
  parent.onCleanup(() => {
    order.push("parent");
  });
  const childDone = child.dispose();
  const parentDone = parent.dispose();
  let settled = false;
  void parentDone.then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(order).toEqual([]);
  release();
  await parentDone;
  await childDone;
  expect(order).toEqual(["child", "parent"]);
});

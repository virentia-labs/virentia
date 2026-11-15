import { describe, expect, it, vi } from "vitest";
import { computed, getOwner, scope, scoped } from "../../lib";
import { f, staticModel } from "../../lib/models";
import { ModelTaskOwner } from "../../lib/models/task-owner";

describe("model task ownership", () => {
  it("keeps one isolated owner per instance across cached computed reads", () => {
    const Model = staticModel({
      data: { count: f.number(0) },
      setup() {
        return { taskOwner: computed(() => getOwner()!) };
      },
    });
    const app = scope();
    const [a, b] = scoped(app, () => [Model.create({ id: "a" }), Model.create({ id: "b" })]);
    const first = a.taskOwner.value;
    expect(first).toBe(a.taskOwner.value);
    expect(first).not.toBe(b.taskOwner.value);
    expect(first.disposed).toBe(false);
    a.dispose();
    expect(first.disposed).toBe(true);
    expect(b.taskOwner.value.disposed).toBe(false);
    b.dispose();
  });

  it("retains detached methods, duplicate registration, cancellation and reverse order", () => {
    const owner = new ModelTaskOwner();
    const { onCleanup, dispose } = owner;
    const seen: number[] = [];
    const repeated = () => {
      seen.push(1);
    };
    onCleanup(repeated);
    const cancel = onCleanup(repeated);
    onCleanup(() => {
      seen.push(2);
    });
    cancel();
    cancel();
    expect(owner.dispose).toBe(dispose);
    expect(owner.onCleanup).toBe(onCleanup);
    dispose();
    expect(seen).toEqual([2]);
    dispose();
    onCleanup(() => {
      seen.push(3);
    });
    expect(seen).toEqual([2, 3]);
  });

  it("runs all callbacks before rethrowing the first cleanup error", () => {
    const owner = new ModelTaskOwner();
    const first = Error("first"),
      last = Error("last");
    const cleaned = vi.fn();
    owner.onCleanup(() => {
      throw first;
    });
    owner.onCleanup(cleaned);
    owner.onCleanup(() => {
      throw last;
    });
    expect(() => owner.dispose()).toThrow(last);
    expect(cleaned).toHaveBeenCalledTimes(1);
    expect(owner.disposed).toBe(true);
    expect(() => owner.dispose()).not.toThrow();
  });

  it("symbol disposal still dispatches through an overridden public method", () => {
    const owner = new ModelTaskOwner();
    const original = owner.dispose;
    const custom = vi.fn(original);
    owner.dispose = custom;
    const dispose = owner[Symbol.dispose];
    dispose();
    expect(custom).toHaveBeenCalledTimes(1);
    expect(owner.disposed).toBe(true);
  });
});

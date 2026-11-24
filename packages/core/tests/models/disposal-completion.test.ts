import { describe, expect, it, vi } from "vitest";
import { scope, scoped } from "../../lib";
import { modelInstanceBindingOf } from "../../lib/internal";
import { f, model, staticModel } from "../../lib/models";
import { instanceInternalOf } from "../../lib/models/definition";

for (const define of [model, staticModel]) {
  describe(`${define.name} disposal completion`, () => {
    it("interleaves native lifetime participants with callbacks and awaits their work", async () => {
      const Model = define({ data: { count: f.number(0) } });
      const instance = scoped(scope(), () => Model.create({ id: "participant" }));
      const binding = modelInstanceBindingOf(instance)!;
      const seen: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const removed = {
        beforeDispose() {
          throw Error("already removed");
        },
      };
      const participant = Object.freeze({
        beforeDispose() {
          expect(this).toBe(participant);
          seen.push("participant");
          binding.removeDisposalParticipant!(participant);
          binding.beforeDispose(() => {
            seen.push("added");
          });
          return gate;
        },
      });
      binding.addDisposalParticipant!(removed);
      binding.removeDisposalParticipant!(removed);
      binding.beforeDispose(() => {
        seen.push("before");
      });
      binding.addDisposalParticipant!(participant);
      binding.addDisposalParticipant!(participant);
      binding.beforeDispose(() => {
        seen.push("after");
      });
      const pending = instance.dispose();
      expect(seen).toEqual(["before", "participant", "after", "added"]);
      expect(instance.alive).toBe(true);
      release();
      await pending;
      expect(instance.alive).toBe(false);
    });

    it("finishes synchronous disposal immediately and settles reentrant callers", async () => {
      const Model = define({ data: { count: f.number(0) } });
      const instance = scoped(scope(), () => Model.create({ id: "row" }));
      let reentrant!: Promise<void>;
      let repeated!: Promise<void>;
      const seen: boolean[] = [];
      modelInstanceBindingOf(instance)!.beforeDispose(() => {
        reentrant = instance.dispose() as Promise<void>;
        repeated = instance.dispose() as Promise<void>;
        seen.push(instance.alive);
      });
      expect(instance.dispose()).toBeUndefined();
      expect(seen).toEqual([true]);
      expect(instance.alive).toBe(false);
      expect(reentrant).toBeInstanceOf(Promise);
      expect(repeated).toBe(reentrant);
      await reentrant;
      expect(instance.dispose()).toBeUndefined();
    });

    it("returns one native promise while asynchronous lifecycle work is pending", async () => {
      const Model = define({ data: { count: f.number(0) } });
      const instance = scoped(scope(), () => Model.create({ id: "row" }));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      modelInstanceBindingOf(instance)!.beforeDispose(() => gate);
      const first = instance.dispose();
      expect(first).toBeInstanceOf(Promise);
      expect(instance.dispose()).toBe(first);
      expect(instance.alive).toBe(true);
      release();
      await first;
      expect(instance.alive).toBe(false);
    });

    it("rejects synchronous lifecycle failures after completing physical teardown", async () => {
      const Model = define({ data: { count: f.number(0) } });
      const instance = scoped(scope(), () => Model.create({ id: "row" }));
      const failure = Error("lifecycle failed");
      modelInstanceBindingOf(instance)!.beforeDispose(() => {
        throw failure;
      });
      const completion = instance.dispose();
      expect(instance.alive).toBe(false);
      await expect(completion).rejects.toMatchObject({ errors: [failure] });
    });

    it("settles an already requested completion when a later callback rejects", async () => {
      const Model = define({ data: { count: f.number(0) } });
      const instance = scoped(scope(), () => Model.create({ id: "row" }));
      const failure = Error("async lifecycle failed");
      let reentrant!: Promise<void>;
      modelInstanceBindingOf(instance)!.beforeDispose(() => {
        reentrant = instance.dispose() as Promise<void>;
      });
      modelInstanceBindingOf(instance)!.beforeDispose(() => Promise.reject(failure));
      const completion = instance.dispose();
      expect(completion).toBe(reentrant);
      await expect(completion).rejects.toMatchObject({ errors: [failure] });
      expect(instance.alive).toBe(false);
    });

    it("shares only a formatted framework stack, without retaining an Error", () => {
      const Model = define({ data: { count: f.number(0) } });
      const app = scope();
      const trace: { stack?: string } = {};
      const dispose = (instance: object) =>
        modelInstanceBindingOf(instance)!.disposeWithTrace!(trace);
      const first = scoped(app, () => Model.create({ id: "a" }));
      const second = scoped(app, () => Model.create({ id: "b" }));
      expect(dispose(first)).toBeUndefined();
      expect(typeof trace.stack).toBe("string");
      const stack = trace.stack;
      expect(dispose(second)).toBeUndefined();
      expect(trace.stack).toBe(stack);
      expect(instanceInternalOf(first)!.disposedSite).toBe(trace);
      expect(instanceInternalOf(second)!.disposedSite).toBe(trace);
      expect(() => first.count.value).toThrow("entity was disposed");
    });

    it("honours customized and frozen public dispose methods", () => {
      const Model = define({ data: { count: f.number(0) } });
      const app = scope();
      const instance = scoped(app, () => Model.create({ id: "custom" }));
      const original = instance.dispose;
      const customized = vi.fn(() => original());
      Object.defineProperty(instance, "dispose", { configurable: true, value: customized });
      const trace: { stack?: string } = {};
      modelInstanceBindingOf(instance)!.disposeWithTrace!(trace);
      expect(customized).toHaveBeenCalledTimes(1);
      expect(instance.alive).toBe(false);
      expect(trace.stack).toBeUndefined();
      const frozen = Object.freeze(scoped(app, () => Model.create({ id: "frozen" })));
      modelInstanceBindingOf(frozen)!.disposeWithTrace!(trace);
      expect(frozen.alive).toBe(false);
      expect(trace.stack).toBeUndefined();
    });

    it("does not attribute asynchronous finalization to a cached synchronous call site", async () => {
      const Model = define({ data: { count: f.number(0) } });
      const instance = scoped(scope(), () => Model.create({ id: "row" }));
      const trace = { stack: "dispose site\n at unrelated synchronous frame" };
      modelInstanceBindingOf(instance)!.beforeDispose(() => Promise.resolve());
      await modelInstanceBindingOf(instance)!.disposeWithTrace!(trace);
      expect(instanceInternalOf(instance)!.disposedSite).toBeInstanceOf(Error);
      expect(instanceInternalOf(instance)!.disposedSite).not.toBe(trace);
    });
  });
}

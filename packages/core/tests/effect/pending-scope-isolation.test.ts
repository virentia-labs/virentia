import { describe, expect, it } from "vitest";
import { effect, scope, scoped } from "../../lib";
import { flush, never } from "../support/async-flush";

describe("effect", () => {
  describe("per-scope pending isolation", () => {
    it("reports pending true independently in each scope for concurrent calls", async () => {
      const scopeA = scope();
      const scopeB = scope();
      const fx = effect<number, string, unknown>(() => never<string>());

      scoped(scopeA, () => {
        void fx(1);
      });
      await flush();

      // scopeB has not called yet: its per-scope pending/inFlight are untouched.
      scoped(scopeB, () => {
        expect(fx.pending.value).toBe(false);
        expect(fx.inFlight.value).toBe(0);
      });

      scoped(scopeB, () => {
        void fx(2);
      });
      await flush();

      // Each scope now reads its own isolated pending/inFlight — no contamination.
      scoped(scopeA, () => {
        expect(fx.pending.value).toBe(true);
        expect(fx.inFlight.value).toBe(1);
      });
      scoped(scopeB, () => {
        expect(fx.pending.value).toBe(true);
        expect(fx.inFlight.value).toBe(1);
      });
    });

    it("keeps a second concurrent call in one scope pending while another scope drains", async () => {
      const scopeA = scope();
      const scopeB = scope();
      const resolvers = new Map<number, (value: string) => void>();
      const fx = effect(
        (value: number) =>
          new Promise<string>((resolve) => {
            resolvers.set(value, resolve);
          }),
      );

      let a1!: Promise<string>;
      scoped(scopeA, () => {
        a1 = fx(1);
      });
      scoped(scopeB, () => {
        void fx(2);
      });
      await flush();

      scoped(scopeA, () => expect(fx.pending.value).toBe(true));
      scoped(scopeB, () => expect(fx.pending.value).toBe(true));

      // Drain scopeA only.
      resolvers.get(1)!("a");
      await a1;
      await flush();

      scoped(scopeA, () => {
        expect(fx.pending.value).toBe(false);
        expect(fx.inFlight.value).toBe(0);
      });
      // scopeB is still in flight and reads its own pending true.
      scoped(scopeB, () => {
        expect(fx.pending.value).toBe(true);
        expect(fx.inFlight.value).toBe(1);
      });
    });
  });
});

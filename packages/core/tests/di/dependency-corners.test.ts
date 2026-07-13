import { describe, expect, it } from "vitest";
import { computed, dependency, provideDependency, scope, scoped, store } from "../../lib";

describe("dependency corner cases", () => {
  describe("the same dependency provided in two scopes with different values", () => {
    it("reads each scope's own value, not a shared one", () => {
      const rate = dependency<number>("rate");
      const a = scope({ deps: [[rate, 2]] });
      const b = scope({ deps: [[rate, 5]] });

      // Same dependency object, distinct values per scope: each read resolves
      // against the *active* scope's `deps` map.
      expect(scoped(a, () => rate.value)).toBe(2);
      expect(scoped(b, () => rate.value)).toBe(5);
      // Re-reading `a` still yields `a`'s value — `b`'s read never leaked over.
      expect(scoped(a, () => rate.value)).toBe(2);
    });

    it("does not recompute a computed when a same-named dependency differs per scope", () => {
      // A computed reads BOTH a reactive store and a non-reactive dependency.
      const factor = dependency<number>("factor");
      const base = store(10);
      const product = computed(() => base.value * factor.value);

      const a = scope({ values: [[base, 10]], deps: [[factor, 2]] });
      const b = scope({ values: [[base, 10]], deps: [[factor, 3]] });

      // Each scope evaluates independently, so it reads its own `factor`. This is
      // per-scope state, NOT a reactive edge on the dependency.
      expect(scoped(a, () => product.value)).toBe(20); // 10 * 2
      expect(scoped(b, () => product.value)).toBe(30); // 10 * 3

      // Prove the dependency read is not reactive: swap `factor` in scope `a`
      // after the computed already cached. The store never changed, so the
      // computed stays clean and re-reads the CACHED value — the new dependency
      // value is ignored until something reactive invalidates the computed.
      scoped(a, () => {
        provideDependency(a, factor, 1000);
        expect(product.value).toBe(20); // still cached, dependency read did not invalidate

        // A tracked store write DOES invalidate; only then is the (now newer)
        // dependency value read again.
        base.value = 11;
        expect(product.value).toBe(11 * 1000); // 11000
      });

      // Scope `b` was untouched by any of the above.
      expect(scoped(b, () => product.value)).toBe(30);
    });
  });

  describe("provideDependency overwriting a value after the scope already read it", () => {
    // NOTE: the dependency doc states deps "do not change over a scope's life".
    // Overwriting after a read technically works because the getter re-reads
    // `scope.deps` on every access, but it is a footgun: the next read silently
    // returns the NEW value and any value already captured from an earlier read
    // is NOT updated (dependencies are not reactive, so nothing is notified).
    it("returns the new value on the next read but does not notify an earlier reader", () => {
      const token = dependency<string>("token");
      const s = scope({ deps: [[token, "first"]] });

      const captured = scoped(s, () => token.value);
      expect(captured).toBe("first");

      // Overwrite the already-read value.
      provideDependency(s, token, "second");

      // The next read returns the NEW value...
      expect(scoped(s, () => token.value)).toBe("second");
      // ...but the value captured earlier is a plain snapshot; it is untouched.
      expect(captured).toBe("first");
      // Last-write-wins: still a single entry, not two.
      expect(s.deps.size).toBe(1);
    });

    it("does not re-run a computed that already read the overwritten dependency", () => {
      // Reinforces the footgun: a consumer (here, a computed) that read the
      // dependency before the overwrite keeps its cached result — the overwrite
      // is invisible to it because dependency reads are not reactive.
      const flag = dependency<boolean>("flag");
      const trigger = store(0);
      const label = computed(() => `${trigger.value}:${flag.value}`);
      const s = scope({ values: [[trigger, 0]], deps: [[flag, true]] });

      scoped(s, () => {
        expect(label.value).toBe("0:true");

        provideDependency(s, flag, false);
        // No reactive dependency changed, so the cached computed is returned.
        expect(label.value).toBe("0:true");
      });
    });
  });
});

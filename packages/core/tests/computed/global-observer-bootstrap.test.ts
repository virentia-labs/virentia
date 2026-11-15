import { describe, expect, it } from "vitest";
import { computed, scope, scoped, store, type Store } from "../../lib";
import { flush } from "../support/store-helpers";

// A scope-less observer discovers its computed's dependencies by evaluating it
// once in an empty scope. Observers attached in one synchronous burst share
// that scope, so a computed already evaluated for an earlier observer is read
// from its cache instead of re-running its whole upstream graph again.
describe("computed", () => {
  describe("activating scope-less observers over a deep graph", () => {
    function chain(depth: number) {
      const source = store(1);
      const counter = { runs: 0 };
      const links: Store<number>[] = [];
      let previous: Store<number> = computed(() => {
        counter.runs += 1;
        return source.value;
      });
      links.push(previous);
      for (let index = 1; index < depth; index++) {
        const parent = previous;
        previous = computed(() => {
          counter.runs += 1;
          return parent.value + 1;
        });
        links.push(previous);
      }
      return { source, counter, links };
    }

    it("evaluates each link a bounded number of times when observed upstream first", async () => {
      const depth = 200;
      const { source, counter, links } = chain(depth);
      const seen: number[] = [];
      for (const link of links) link.subscribe((value) => seen.push(value));

      // One bootstrap per link plus at most one cached evaluation as an upstream
      // of the next — not one evaluation of the whole prefix per observer.
      expect(counter.runs).toBeLessThanOrEqual(2 * depth);

      const sc = scope();
      await scoped(sc, () => {
        source.value = 2;
      });
      await flush();
      expect(seen).toHaveLength(depth);
      expect(seen.at(-1)).toBe(2 + depth - 1);
    });

    it("evaluates each link a bounded number of times when only the tail is observed", async () => {
      const depth = 200;
      const { source, counter, links } = chain(depth);
      const seen: number[] = [];
      links.at(-1)!.subscribe((value) => seen.push(value));

      // The tail's bootstrap activates every upstream link transitively.
      expect(counter.runs).toBeLessThanOrEqual(2 * depth);

      const sc = scope();
      await scoped(sc, () => {
        source.value = 5;
      });
      await flush();
      expect(seen).toEqual([5 + depth - 1]);
    });

    it("discovers dependencies afresh for observers attached after the burst", async () => {
      const source = store(1);
      const first = computed(() => source.value * 2);
      first.subscribe(() => {});
      await Promise.resolve();

      const second = computed(() => first.value + 1);
      const seen: number[] = [];
      second.subscribe((value) => seen.push(value));

      const sc = scope();
      await scoped(sc, () => {
        source.value = 3;
      });
      await flush();
      expect(seen).toEqual([7]);
    });
  });
});

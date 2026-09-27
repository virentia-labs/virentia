import { describe, expect, it } from "vitest";
import { computed, scope, scoped } from "../../lib";
import { collectModelFieldReads, collection, f, staticModel } from "../../lib/models";
import type { ModelFieldReadSource } from "../../lib/models";

describe("model field read collector", () => {
  it("collects stable field/member sources and filters instance notifications", () => {
    const Todo = staticModel({
      data: { title: f.string("") },
      setup(self: any) {
        return { upper: computed(() => self.title.value.toUpperCase()) };
      },
    });
    const app = scope();

    scoped(app, () => {
      const todos = collection(Todo);
      const first = todos.add({ id: "first", title: "one" });
      const second = todos.add({ id: "second", title: "two" });
      const sources = new Set<ModelFieldReadSource>();
      const value = collectModelFieldReads(
        (source) => sources.add(source),
        () => `${first.title.value}:${first.upper.value}`,
      );

      expect(value).toBe("one:ONE");
      expect(sources.size).toBe(2);
      const [field] = sources;
      const seen: string[] = [];
      const unsubscribe = field!.subscribe(() => seen.push(first.title.value));

      second.title.value = "changed";
      expect(seen).toEqual([]);
      first.title.value = "updated";
      expect(seen).toEqual(["updated"]);
      unsubscribe();
      first.title.value = "again";
      expect(seen).toEqual(["updated"]);
    });
  });
});

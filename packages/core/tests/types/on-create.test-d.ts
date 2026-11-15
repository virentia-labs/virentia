import { expectTypeOf } from "vitest";
import { computed } from "../../lib/index";
import { f, model, staticModel } from "../../lib/models";
import type { Props } from "../../lib/models";

staticModel({
  data: { title: f.string(""), count: f.number(0).local() },
  setup(self) {
    return { doubled: computed(() => self.count.value * 2), label: () => self.title.value };
  },
  onCreate(self) {
    expectTypeOf(self.title.value).toEqualTypeOf<string>();
    expectTypeOf(self.doubled.value).toEqualTypeOf<number>();
    expectTypeOf(self.label()).toEqualTypeOf<string>();
    // @ts-expect-error The instance only exposes declared fields and members.
    self.missing;
  },
});
model({
  data: (p: Props<{ title: string }>) => ({ title: f.string(p.title) }),
  setup(self) {
    return { label: () => self.title.value };
  },
  onCreate(self) {
    expectTypeOf(self.label()).toEqualTypeOf<string>();
  },
});

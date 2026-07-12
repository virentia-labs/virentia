import { bench, describe } from "vitest";
import { produce } from "immer";
import { create } from "mutative";
import { createRootDraft } from "../lib/draft";

// Repeated deep updates to an evolving store (the real mutable-store usage):
// `@virentia/mutable` mutates the scope's owned value in place, while immer and
// mutative produce a fresh immutable value each time. Each case is a
// 50 000-item array with a growing number of items touched per update.
const N = 50000;
const seed = () => ({ items: Array.from({ length: N }, (_, i) => ({ id: i, v: 0 })) });

function suite(touch: number) {
  const step = Math.floor(N / touch);
  const recipe = (d: any) => {
    for (let i = 0; i < touch; i++) d.items[i * step].v++;
  };

  let im = seed();
  bench("immer", () => {
    im = produce(im, recipe);
  });

  let mu = seed();
  bench("mutative", () => {
    mu = create(mu, recipe);
  });

  let current: any = seed();
  const owned = new WeakSet<object>();
  // No reader is tracking in this write-only benchmark, so the draft's read
  // hooks never fire — the fine-grained keypath machinery adds nothing here.
  const env = {
    owned,
    onChange: () => {},
    onRead: () => {},
    onReadAll: () => {},
    isTracking: () => false,
  };
  bench("@virentia/mutable", () => {
    const draft = createRootDraft(current, env);
    recipe(draft.proxy);
    current = draft.latest();
  });
}

describe("50k array, touch 1000", () => suite(1000));
describe("50k array, touch 5000", () => suite(5000));
describe("50k array, touch all", () => suite(N));

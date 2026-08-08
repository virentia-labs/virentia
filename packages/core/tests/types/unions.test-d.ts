import { describe, expectTypeOf, it } from "vitest";
import { children, collection, f, refs, staticModel, trait, union } from "../../lib/models";

// §5.2 at the type level: variant identity is a model reference, `match` is
// exhaustive at compile time, commonality of a member requires the same trait
// (the `~originT` stamp), and `add` exists only after `.by(...)`.

describe("§5.2 typed unions", () => {
  const Timestamped = trait({ data: { ts: f.number(0) } });

  const Post = staticModel({
    with: [Timestamped],
    data: { title: f.string(), likes: f.number(0) },
  });
  const Ad = staticModel({
    with: [Timestamped],
    data: { budget: f.number(0), active: f.boolean(true) },
  });
  const Story = staticModel({
    with: [Timestamped],
    data: { views: f.number(0) },
  });

  const FeedItem = union(Post, Ad, Story).by((json) =>
    "likes" in json ? Post : "budget" in json ? Ad : Story,
  );

  it("common members come from the shared trait; a variant-only name is not common", () => {
    FeedItem.ts.gte(10);
    FeedItem.ts.between(1, 5);

    // @ts-expect-error ts is a number field
    FeedItem.ts.gte("high");

    // @ts-expect-error `likes` belongs to Post only — not a union member
    FeedItem.likes;
  });

  it("a name coincidence in own data does not create a common member", () => {
    const A = staticModel({ data: { created: f.number(0) } });
    const B = staticModel({ data: { created: f.number(0) } });
    const U = union(A, B);

    // @ts-expect-error `created` is model-own data in both — no shared trait
    U.created;
  });

  it("add exists only after .by(); its input is the union of variant dtos", () => {
    const feed = collection(FeedItem);

    feed.add({ title: "t", likes: 1 });
    feed.add({ budget: 5 });
    feed.add({ id: "p1", likes: 2 }); // partial merge form

    // @ts-expect-error matches no variant dto
    feed.add({ nope: true });

    const NoBy = union(Post, Ad, Story);
    const view = collection(NoBy);

    // @ts-expect-error a union without a discriminator has no add (§5.2)
    view.add({ title: "t", likes: 1 });

    expectTypeOf(view.count).toEqualTypeOf<number>();
  });

  it("items are the union of variant instances; `in` narrows them", () => {
    const feed = collection(FeedItem);
    const item = feed.items[0]!;

    expectTypeOf(item.ts.value).toEqualTypeOf<number>();
    expectTypeOf(item.id).toEqualTypeOf<string>();

    // @ts-expect-error likes exists on the Post variant only until narrowed
    item.likes;

    if ("likes" in item) {
      expectTypeOf(item.likes.value).toEqualTypeOf<number>();
    }

    expectTypeOf(feed.select(FeedItem.ts)).toEqualTypeOf<number[]>();
  });

  it("match is exhaustive by model references, branch callbacks see their variant", () => {
    const feed = collection(FeedItem);

    feed.match(
      [Post, (p) => p.likes.gte(100)],
      [Ad, (a) => a.active.eq(true)],
      [Story, () => true],
    );

    // @ts-expect-error missing the Story variant
    feed.match([Post, (p) => p.likes.gte(100)], [Ad, (a) => a.active.eq(true)]);

    feed.match(
      // @ts-expect-error Post descriptors have no `budget`
      [Post, (p) => p.budget.gte(1)],
      [Ad, (a) => a.budget.gte(1)],
      [Story, () => true],
    );
  });

  it("union query chains keep the union typing", () => {
    const feed = collection(FeedItem);
    const chained = feed.where(FeedItem.ts.gte(1)).sort(FeedItem.ts.desc).take(5);

    expectTypeOf(chained.count).toEqualTypeOf<number>();
    expectTypeOf(chained.ids).toEqualTypeOf<string[]>();

    const first = chained.first;

    if (first !== null && "views" in first) {
      expectTypeOf(first.views.value).toEqualTypeOf<number>();
    }
  });
});

describe("§5.2 union targets in relations", () => {
  const Post = staticModel({ data: { title: f.string() } });
  const Ad = staticModel({ data: { budget: f.number(0) } });
  const FeedItem = union(Post, Ad).by((json) => ("budget" in json ? Ad : Post));

  const Bookmark = staticModel({
    data: { note: f.string(""), target: refs.one(FeedItem) },
  });

  it("refs.one(union) value is the union of variant instances; `in` narrows", () => {
    const bookmarks = collection(Bookmark);
    const b = bookmarks.add({});
    const target = b.target.value;

    if (target !== null && "title" in target) {
      expectTypeOf(target.title.value).toEqualTypeOf<string>();
    }

    if (target !== null && "budget" in target) {
      expectTypeOf(target.budget.value).toEqualTypeOf<number>();
    }

    const posts = collection(Post);

    b.target.value = posts.add({ title: "x" }); // a variant instance is accepted
    b.target.value = null;
  });

  it("children.many(union) add takes the union of variant dtos", () => {
    const Card = staticModel({ data: { items: children.many(FeedItem) } });
    const cards = collection(Card);
    const card = cards.add({});

    card.items.add({ title: "t" });
    card.items.add({ budget: 5 });

    // @ts-expect-error matches no variant dto
    card.items.add({ nope: true });
  });

  it("a thunk union target derefs lazily at the property position (§5.4)", () => {
    const Later = staticModel({ data: { target: refs.one(() => FeedItem) } });
    const holders = collection(Later);
    const holder = holders.add({});
    const target = holder.target.value;

    if (target !== null && "budget" in target) {
      expectTypeOf(target.budget.value).toEqualTypeOf<number>();
    }
  });
});

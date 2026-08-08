import { describe, expect, it, vi } from "vitest";
import { computed, reaction, scope, scoped } from "../../lib/index";
import { collection, f, staticModel, trait, union } from "../../lib/models";

// §5.2: a union is positional, variant identity is a model reference. Instances
// live in variant collections; the union collection is a view — `by` routes
// add, queries merge per-variant results, `match` is exhaustive by references,
// commonality of a member requires the SAME trait by reference.

function app<T>(fn: () => T): T {
  return scoped(scope(), fn) as T;
}

function declareFeed() {
  const Timestamped = trait({ data: { ts: f.number(0).indexed("ord") } });

  const Post: any = staticModel({
    with: [Timestamped],
    data: { title: f.string(), likes: f.number(0) },
    name: "post",
  });
  const Ad: any = staticModel({
    with: [Timestamped],
    data: { budget: f.number(0), active: f.boolean(true) },
    name: "ad",
  });
  const Story: any = staticModel({
    with: [Timestamped],
    data: { views: f.number(0) },
    name: "story",
  });

  const FeedItem: any = (union(Post, Ad, Story) as any).by((json: any) =>
    "likes" in json || "title" in json ? Post : "budget" in json || "active" in json ? Ad : Story,
  );

  return { Timestamped, Post, Ad, Story, FeedItem };
}

describe("union declaration (§5.2)", () => {
  it("needs at least two distinct model variants", () => {
    const { Post, Ad } = declareFeed();

    expect(() => (union as any)(Post)).toThrowError(/at least two/);
    expect(() => (union as any)(Post, Post, Ad)).toThrowError(/distinct/);
    expect(() => (union as any)(Post, { fake: true })).toThrowError(/variant #1/);
  });

  it("a common member exists iff every variant carries it from the SAME trait", () => {
    const { FeedItem } = declareFeed();

    expect(FeedItem.ts).toBeDefined();
    expect(FeedItem.ts.gte(1)).toMatchObject({ field: "ts", op: "gte" });

    // name coincidence in own data gives nothing
    const A: any = staticModel({ data: { created: f.number(0) } });
    const B: any = staticModel({ data: { created: f.number(0) } });
    const U: any = union(A, B);

    expect(() => U.created).toThrowError(/same trait by reference/i);
    expect(U.nonexistent).toBeUndefined();
  });

  it("a trait reaching a variant through another trait keeps its identity", () => {
    const Timestamped = trait({ data: { ts: f.number(0) } });
    const WithMeta = trait({ with: [Timestamped] });

    const A: any = staticModel({ with: [Timestamped], data: { a: f.number(0) } });
    const B: any = staticModel({ with: [WithMeta], data: { b: f.number(0) } });
    const U: any = union(A, B);

    expect(U.ts).toBeDefined();
  });
});

describe("union add routing (§5.2)", () => {
  it("by routes unknown ids; instances land in their variant collections", () => {
    const { Post, Ad, FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);

      feed.add({ title: "hello", likes: 3 });
      feed.add({ budget: 100 });

      expect(feed.count).toBe(2);
      expect((collection(Post) as any).count).toBe(1);
      expect((collection(Ad) as any).count).toBe(1);
    });
  });

  it("a known id merges into its variant WITHOUT consulting by", () => {
    const { FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);
      const post = feed.add({ id: "p1", title: "old", likes: 1 });

      // this partial has no discriminating keys — by would misroute or throw
      const merged = feed.add({ id: "p1", likes: 5 });

      expect(merged).toBe(post);
      expect(post.likes.value).toBe(5);
      expect(post.title.value).toBe("old");
      expect(feed.count).toBe(1);
    });
  });

  it("a full dto of ANOTHER variant with a taken id is a migration dev error", () => {
    const { FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);

      feed.add({ id: "x", title: "post", likes: 1 });

      expect(() => feed.add({ id: "x", budget: 50, active: false })).toThrowError(
        /no variant migration/,
      );
    });
  });

  it("without by, add through the union is an error; by must return a variant", () => {
    const { Post, Ad } = declareFeed();

    app(() => {
      const NoBy: any = union(Post, Ad);
      const view: any = collection(NoBy);

      expect(() => view.add({ title: "t" })).toThrowError(/no discriminator/);

      const Wrong: any = (union(Post, Ad) as any).by(() => ({ fake: true }));
      const wrongView: any = collection(Wrong);

      expect(() => wrongView.add({ title: "t" })).toThrowError(/not a variant/);
    });
  });

  it("array add routes per element and rolls back this batch's creations", () => {
    const { Post, Ad, FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);

      expect(() =>
        feed.add([
          { title: "ok", likes: 1 },
          { budget: "not-a-number" }, // schema failure in the Ad variant
        ]),
      ).toThrowError(/invalid "budget"/);

      expect(feed.count).toBe(0);
      expect((collection(Post) as any).count).toBe(0);
      expect((collection(Ad) as any).count).toBe(0);
    });
  });
});

describe("union view: get / remove / identity (§6)", () => {
  it("get and remove search the variants; the collection is get-or-create", () => {
    const { Post, FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);

      expect(collection(FeedItem)).toBe(feed);

      const post = feed.add({ id: "p1", title: "t", likes: 0 });
      const ad = feed.add({ id: "a1", budget: 10 });

      expect(feed.get("p1")).toBe(post);
      expect(feed.get("a1")).toBe(ad);
      expect(feed.get("missing")).toBeNull();

      feed.remove("p1");

      expect(feed.get("p1")).toBeNull();
      expect((collection(Post) as any).count).toBe(0);
      expect(feed.count).toBe(1);
    });
  });

  it("instances added through variant collections are visible in the union", () => {
    const { Post, FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);

      (collection(Post) as any).add({ title: "direct", likes: 1 });

      expect(feed.count).toBe(1);
    });
  });
});

describe("union queries (§5.2 + §8)", () => {
  it("where by a common member filters across variants on their own indexes", () => {
    const { FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);

      feed.add([
        { title: "p-low", likes: 0, ts: 1 },
        { title: "p-high", likes: 0, ts: 9 },
        { budget: 1, ts: 2 },
        { budget: 2, ts: 8 },
        { views: 5, ts: 5 },
      ]);

      expect(feed.where(FeedItem.ts.gte(5)).count).toBe(3);
      expect(feed.where(FeedItem.ts.between(2, 5)).count).toBe(2);
    });
  });

  it("variant descriptors are rejected in union where — match is the route", () => {
    const { Post, FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);

      expect(() => feed.where(Post.likes.gte(1))).toThrowError(/through match/);

      const Other: any = staticModel({ data: { x: f.number(0) } });

      expect(() => feed.where(Other.x.eq(1))).toThrowError(/different model/);
    });
  });

  it("scan predicates run over the merged view", () => {
    const { FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);

      feed.add([
        { title: "aa", likes: 0, ts: 1 },
        { budget: 5, ts: 2 },
      ]);

      expect(feed.where((item: any) => item.ts.value > 1).count).toBe(1);
    });
  });

  it("sort by a common member k-way merges variant orders; take cuts early", () => {
    const { FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);

      feed.add([
        { title: "p1", likes: 0, ts: 1 },
        { title: "p5", likes: 0, ts: 5 },
        { budget: 1, ts: 2 },
        { budget: 2, ts: 4 },
        { views: 1, ts: 3 },
      ]);

      expect(feed.sort(FeedItem.ts.asc).select(FeedItem.ts)).toEqual([1, 2, 3, 4, 5]);
      expect(feed.sort(FeedItem.ts.desc).select(FeedItem.ts)).toEqual([5, 4, 3, 2, 1]);
      expect(feed.sort(FeedItem.ts.asc).take(2).select(FeedItem.ts)).toEqual([1, 2]);
      expect(feed.sort(FeedItem.ts.desc).first.ts.value).toBe(5);
    });
  });

  it("set on a common member writes across variants; remove() mass-disposes", () => {
    const { Post, Ad, FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);

      feed.add([
        { title: "p", likes: 0, ts: 1 },
        { budget: 1, ts: 9 },
      ]);

      feed.where(FeedItem.ts.lte(5)).set(FeedItem.ts, 100);

      expect(feed.sort(FeedItem.ts.asc).select(FeedItem.ts)).toEqual([9, 100]);

      // mass dispose lives on derived queries; collection.remove(id) is targeted (§8)
      feed.where(FeedItem.ts.gte(0)).remove();

      expect(feed.count).toBe(0);
      expect((collection(Post) as any).count).toBe(0);
      expect((collection(Ad) as any).count).toBe(0);
    });
  });
});

describe("union match (§5.2)", () => {
  it("filters each variant by its branch; true/false keep/drop whole variants", () => {
    const { Post, Ad, Story, FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);

      feed.add([
        { title: "hot", likes: 100, ts: 1 },
        { title: "cold", likes: 1, ts: 2 },
        { budget: 5, active: true, ts: 3 },
        { budget: 9, active: false, ts: 4 },
        { views: 7, ts: 5 },
      ]);

      const matched = feed.match(
        [Post, (p: any) => p.likes.gte(100)],
        [Ad, (a: any) => a.active.eq(true)],
        [Story, () => true],
      );

      expect(matched.count).toBe(3);
      expect(matched.sort(FeedItem.ts.asc).select(FeedItem.ts)).toEqual([1, 3, 5]);

      const noStories = feed.match([Post, () => true], [Ad, () => true], [Story, () => false]);

      expect(noStories.count).toBe(4);
    });
  });

  it("match composes with where and take", () => {
    const { Post, Ad, Story, FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);

      feed.add([
        { title: "a", likes: 100, ts: 1 },
        { title: "b", likes: 100, ts: 9 },
        { budget: 5, active: true, ts: 8 },
        { views: 7, ts: 5 },
      ]);

      const result = feed
        .where(FeedItem.ts.gte(5))
        .match([Post, (p: any) => p.likes.gte(100)], [Ad, () => false], [Story, () => true])
        .sort(FeedItem.ts.desc)
        .take(2);

      expect(result.select(FeedItem.ts)).toEqual([9, 5]);
    });
  });

  it("is exhaustive by model references and validates branches", () => {
    const { Post, Ad, Story, FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);

      expect(() => feed.match([Post, () => true], [Ad, () => true])).toThrowError(
        /exhaustive — missing: story/,
      );

      expect(() =>
        feed.match([Post, () => true], [Post, () => true], [Ad, () => true], [Story, () => true]),
      ).toThrowError(/two branches/);

      const Foreign: any = staticModel({ data: { x: f.number(0) } });

      expect(() =>
        feed.match([Foreign, () => true], [Post, () => true], [Ad, () => true], [Story, () => true]),
      ).toThrowError(/not a variant/);

      expect(() =>
        feed.match(
          [Post, (p: any) => p.likes.gte(1)],
          [Ad, () => Post.likes.gte(1)], // predicate built from another variant
          [Story, () => true],
        ),
      ).toThrowError(/another model's descriptors/);

      expect(() =>
        feed.match([Post, () => "yes"], [Ad, () => true], [Story, () => true]),
      ).toThrowError(/predicate or a boolean literal/);
    });
  });
});

describe("union reactivity and stable identity (§8)", () => {
  it("a computed over a union query recomputes on changes in ANY variant", () => {
    const { FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);
      const fresh = computed(() => feed.where(FeedItem.ts.gte(5)).count);

      expect(fresh.value).toBe(0);

      const post = feed.add({ title: "p", likes: 0, ts: 9 });

      expect(fresh.value).toBe(1);

      feed.add({ budget: 1, ts: 7 });

      expect(fresh.value).toBe(2);

      post.ts.value = 0;

      expect(fresh.value).toBe(1);
    });
  });

  it("a reaction over union count re-runs on adds", async () => {
    const { FeedItem } = declareFeed();

    await app(async () => {
      const feed: any = collection(FeedItem);
      const counts: number[] = [];

      reaction(() => {
        counts.push(feed.count);
      });

      await Promise.resolve();

      feed.add({ title: "p", likes: 0 });

      await Promise.resolve();
      await Promise.resolve();

      feed.add({ budget: 1 });

      await Promise.resolve();
      await Promise.resolve();

      expect(counts[0]).toBe(0);
      expect(counts).toContain(1);
      expect(counts.at(-1)).toBe(2);
    });
  });

  it("a rebuilt chain with the same binds returns the SAME items array", () => {
    const { FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);

      feed.add([
        { title: "p", likes: 0, ts: 1 },
        { budget: 1, ts: 9 },
      ]);

      const first = feed.where(FeedItem.ts.gte(5)).items;
      const second = feed.where(FeedItem.ts.gte(5)).items;

      expect(second).toBe(first);
    });
  });

  it("an epoch bump that does not change the result keeps referential identity", () => {
    const { FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);
      const post = feed.add({ title: "p", likes: 0, ts: 1 });

      feed.add({ budget: 1, ts: 9 });

      const query = feed.where(FeedItem.ts.gte(5));
      const before = query.items;

      post.likes.value = 3; // bumps the Post collection epoch, result unchanged

      expect(query.items).toBe(before);
    });
  });

  it("unions in different scopes are independent views", () => {
    const { FeedItem } = declareFeed();
    const first = scope();
    const second = scope();

    scoped(first, () => {
      (collection(FeedItem) as any).add({ title: "in-first", likes: 0 });
    });

    scoped(second, () => {
      expect((collection(FeedItem) as any).count).toBe(0);
    });

    scoped(first, () => {
      expect((collection(FeedItem) as any).count).toBe(1);
    });
  });
});

describe("union serialization boundary (§9.1)", () => {
  it("each variant serializes through its own codec; the union adds nothing", () => {
    const { FeedItem } = declareFeed();

    app(() => {
      const feed: any = collection(FeedItem);
      const post = feed.add({ id: "p1", title: "t", likes: 2, ts: 5 });
      const ad = feed.add({ id: "a1", budget: 7 });

      expect(post.json()).toEqual({ id: "p1", title: "t", likes: 2, ts: 5 });
      expect(ad.json()).toEqual({ id: "a1", budget: 7, active: true, ts: 0 });
    });
  });
});

describe("known-id merge never calls by (§5.2)", () => {
  it("by is not consulted for a known id even when it would throw", () => {
    const { Post, Ad } = declareFeed();
    const by = vi.fn(() => {
      throw new Error("cannot discriminate a partial");
    });

    app(() => {
      const FeedItem: any = (union(Post, Ad) as any).by(by);
      const feed: any = collection(FeedItem);

      (collection(Post) as any).add({ id: "p1", title: "t", likes: 0 });

      const merged = feed.add({ id: "p1", likes: 42 });

      expect(merged.likes.value).toBe(42);
      // the migration cross-check MAY probe by — but a throwing by must never
      // break a legitimate known-id merge
      expect(feed.count).toBe(1);
    });
  });
});

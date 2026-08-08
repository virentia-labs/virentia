import { describe, expect, it } from "vitest";
import { scope, scoped } from "../../lib/index";
import { collection, f, inverse, refs, children, staticModel, trait, union } from "../../lib/models";

// §5.2 «Хранение» + §5.4: relations may target a UNION. Instance writes store
// (model, id) pairs — an id alone cannot name the variant; wire loads store the
// bare id (unresolved) and resolve at first navigation, ambiguity is a dev
// error. Policies, cascade and rebind stay precise under cross-variant id
// collisions.

function app<T>(fn: () => T): T {
  return scoped(scope(), fn) as T;
}

function declareContent() {
  const Timestamped = trait({ data: { ts: f.number(0) } });

  const Post: any = staticModel({
    with: [Timestamped],
    data: { title: f.string("") },
    name: "post",
  });
  const Ad: any = staticModel({
    with: [Timestamped],
    data: { budget: f.number(0) },
    name: "ad",
  });
  const FeedItem: any = (union(Post, Ad) as any).by((json: any) =>
    "budget" in json ? Ad : Post,
  );

  return { Post, Ad, FeedItem };
}

describe("refs.one with a union target (§5.2)", () => {
  it("instance writes store the variant; reads resolve precisely", () => {
    const { Post, Ad, FeedItem } = declareContent();
    const Bookmark: any = staticModel({
      data: { note: f.string(""), target: refs.one(FeedItem) },
      name: "bookmark",
    });

    app(() => {
      const bookmarks: any = collection(Bookmark);
      const feed: any = collection(FeedItem);
      const post = feed.add({ id: "p1", title: "t" });
      const ad = feed.add({ id: "a1", budget: 5 });

      const b1 = bookmarks.add({});
      const b2 = bookmarks.add({});

      b1.target.value = post;
      b2.target.value = ad;

      expect(b1.target.value).toBe(post);
      expect(b2.target.value).toBe(ad);

      b1.target.value = null;

      expect(b1.target.value).toBeNull();
    });
  });

  it("a same-id instance of another variant is untouched by delete policies", () => {
    const { Post, Ad, FeedItem } = declareContent();
    const Bookmark: any = staticModel({
      data: { target: refs.one(FeedItem) },
      name: "bookmark",
    });

    app(() => {
      const posts: any = collection(Post);
      const ads: any = collection(Ad);
      const bookmarks: any = collection(Bookmark);
      const post = posts.add({ id: "dup", title: "t" });
      const ad = ads.add({ id: "dup", budget: 1 });

      const toPost: any = bookmarks.add({});
      const toAd: any = bookmarks.add({});

      toPost.target.value = post;
      toAd.target.value = ad;

      posts.remove("dup"); // nullify must hit ONLY the Post-referencing bookmark

      expect(toPost.target.value).toBeNull();
      expect(toAd.target.value).toBe(ad);
    });
  });

  it("serializes as a plain id; a wire id stays lazy and resolves at read", () => {
    const { Post, FeedItem } = declareContent();
    const Bookmark: any = staticModel({
      data: { target: refs.one(FeedItem) },
      name: "bookmark",
    });

    app(() => {
      const bookmarks: any = collection(Bookmark);
      const b = bookmarks.add({ target: "p1" }); // p1 is not loaded yet

      expect(b.target.value).toBeNull();

      const post = (collection(FeedItem) as any).add({ id: "p1", title: "t" });

      expect(b.target.value).toBe(post);
      expect(b.json().target).toBe("p1");

      b.target.value = post; // upgrade to a concrete pair — same wire output

      expect(b.json().target).toBe("p1");
    });
  });

  it("an ambiguous wire id is a dev error at navigation", () => {
    const { Post, Ad, FeedItem } = declareContent();
    const Bookmark: any = staticModel({
      data: { target: refs.one(FeedItem) },
      name: "bookmark",
    });

    app(() => {
      const posts: any = collection(Post);
      const ads: any = collection(Ad);
      const bookmarks: any = collection(Bookmark);

      posts.add({ id: "dup", title: "t" });
      ads.add({ id: "dup", budget: 1 });

      const b: any = bookmarks.add({ target: "dup" });

      expect(() => b.target.value).toThrowError(/more than one variant/);
    });
  });

  it("rejects an instance whose model is not a variant", () => {
    const { FeedItem } = declareContent();
    const Bookmark: any = staticModel({
      data: { target: refs.one(FeedItem) },
      name: "bookmark",
    });
    const Other: any = staticModel({ data: { x: f.number(0) }, name: "other" });

    app(() => {
      const bookmarks: any = collection(Bookmark);
      const stranger = (collection(Other) as any).add({});
      const b: any = bookmarks.add({});

      expect(() => {
        b.target.value = stranger;
      }).toThrowError(/not a variant/);
    });
  });

  it("a thunk union target resolves lazily", () => {
    const Timestamped = trait({ data: { ts: f.number(0) } });
    const Bookmark: any = staticModel({
      data: { target: refs.one(() => FeedItem) },
      name: "bookmark",
    });
    const Post: any = staticModel({ with: [Timestamped], data: { title: f.string("") }, name: "post" });
    const Ad: any = staticModel({ with: [Timestamped], data: { budget: f.number(0) }, name: "ad" });
    const FeedItem: any = (union(Post, Ad) as any).by((json: any) => ("budget" in json ? Ad : Post));

    app(() => {
      const bookmarks: any = collection(Bookmark);
      const post = (collection(FeedItem) as any).add({ id: "p1", title: "t" });
      const b: any = bookmarks.add({});

      b.target.value = post;

      expect(b.target.value).toBe(post);
    });
  });

  it("restrict through a union target aborts the dispose", () => {
    const { FeedItem } = declareContent();
    const Bookmark: any = staticModel({
      data: { target: (refs.one(FeedItem) as any).policy("restrict") },
      name: "bookmark",
    });

    app(() => {
      const feed: any = collection(FeedItem);
      const bookmarks: any = collection(Bookmark);
      const post = feed.add({ id: "p1", title: "t" });
      const b: any = bookmarks.add({});

      b.target.value = post;

      expect(() => feed.remove("p1")).toThrowError(/restrict/);

      b.target.value = null;
      feed.remove("p1");

      expect(feed.count).toBe(0);
    });
  });
});

describe("refs.many with a union target (§5.2)", () => {
  it("holds a mixed ordered set; serializes as an id list", () => {
    const { FeedItem } = declareContent();
    const Board: any = staticModel({
      data: { pinned: refs.many(FeedItem) },
      name: "board",
    });

    app(() => {
      const feed: any = collection(FeedItem);
      const boards: any = collection(Board);
      const post = feed.add({ id: "p1", title: "t" });
      const ad = feed.add({ id: "a1", budget: 5 });
      const board: any = boards.add({});

      board.pinned.add(post);
      board.pinned.add(ad);
      board.pinned.add(post); // duplicate reference — kept once

      expect(board.pinned.ids).toEqual(["p1", "a1"]);
      expect(board.pinned.items).toEqual([post, ad]);
      expect(board.pinned.count).toBe(2);
      expect(board.json().pinned).toEqual(["p1", "a1"]);

      board.pinned.remove(post);

      expect(board.pinned.ids).toEqual(["a1"]);
    });
  });

  it("wire ids load lazily and keep the wire order", () => {
    const { FeedItem } = declareContent();
    const Board: any = staticModel({
      data: { pinned: refs.many(FeedItem) },
      name: "board",
    });

    app(() => {
      const boards: any = collection(Board);
      const board: any = boards.add({ pinned: ["a1", "p1"] });

      expect(board.pinned.items).toEqual([]); // nothing loaded yet

      const feed: any = collection(FeedItem);
      const post = feed.add({ id: "p1", title: "t" });
      const ad = feed.add({ id: "a1", budget: 5 });

      expect(board.pinned.items).toEqual([ad, post]);
      expect(board.json().pinned).toEqual(["a1", "p1"]);
    });
  });

  it("nullify removes only the dying variant's entry under id collision", () => {
    const { Post, Ad, FeedItem } = declareContent();
    const Board: any = staticModel({
      data: { pinned: refs.many(FeedItem) },
      name: "board",
    });

    app(() => {
      const posts: any = collection(Post);
      const ads: any = collection(Ad);
      const boards: any = collection(Board);
      const post = posts.add({ id: "dup", title: "t" });
      const ad = ads.add({ id: "dup", budget: 1 });
      const board: any = boards.add({});

      board.pinned.add(post);
      board.pinned.add(ad);

      expect(board.pinned.count).toBe(2);

      posts.remove("dup");

      expect(board.pinned.count).toBe(1);
      expect(board.pinned.items).toEqual([ad]);
    });
  });
});

describe("children with a union target (§5.2 + §5.1)", () => {
  it("embedded children route through by; cascade kills across variants", () => {
    const { Post, Ad, FeedItem } = declareContent();
    const Card: any = staticModel({
      data: { items: children.many(FeedItem) },
      name: "card",
    });

    app(() => {
      const cards: any = collection(Card);
      const card: any = cards.add({});

      card.items.add([{ title: "t" }, { budget: 5 }]);

      expect(card.items.count).toBe(2);
      expect((collection(Post) as any).count).toBe(1);
      expect((collection(Ad) as any).count).toBe(1);

      // owned variants may not be created directly (§5.1)
      expect(() => (collection(Post) as any).add({ title: "loose" })).toThrowError(
        /through the parent/,
      );

      card.dispose();

      expect((collection(Post) as any).count).toBe(0);
      expect((collection(Ad) as any).count).toBe(0);
    });
  });

  it("a present children array reconciles: merge by id, drop absent, keep order", () => {
    const { Post, Ad, FeedItem } = declareContent();
    const Card: any = staticModel({
      data: { items: children.many(FeedItem) },
      name: "card",
    });

    app(() => {
      const cards: any = collection(Card);
      const card: any = cards.add({
        id: "c1",
        items: [
          { id: "p1", title: "old" },
          { id: "a1", budget: 1 },
        ],
      });

      expect(card.items.ids).toEqual(["p1", "a1"]);

      cards.add({
        id: "c1",
        items: [
          { id: "a1", budget: 9 }, // merged in place, moved first
          { budget: 2 }, // new ad
        ],
      });

      expect(card.items.count).toBe(2);
      expect((collection(Post) as any).count).toBe(0); // p1 dropped
      expect((collection(Ad) as any).get("a1").budget.value).toBe(9);

      const serialized = card.json();

      expect(serialized.items.map((child: any) => child.budget)).toEqual([9, 2]);
    });
  });

  it("children.one routes create through by; clear disposes the child", () => {
    const { Ad, FeedItem } = declareContent();
    const Card: any = staticModel({
      data: { cover: children.one(FeedItem) },
      name: "card",
    });

    app(() => {
      const cards: any = collection(Card);
      const card: any = cards.add({});
      const cover = card.cover.create({ budget: 7 });

      expect(card.cover.value).toBe(cover);
      expect((collection(Ad) as any).count).toBe(1);

      card.cover.clear();

      expect(card.cover.value).toBeNull();
      expect((collection(Ad) as any).count).toBe(0);
    });
  });
});

describe("rebind with union-target fks (§10.1)", () => {
  it("rewrites only the rebound variant's entries; a same-id neighbor is untouched", () => {
    const { Post, Ad, FeedItem } = declareContent();
    const Bookmark: any = staticModel({
      data: { target: refs.one(FeedItem) },
      name: "bookmark",
    });

    app(() => {
      const posts: any = collection(Post);
      const ads: any = collection(Ad);
      const bookmarks: any = collection(Bookmark);
      const post = posts.add({ id: "old", title: "t" });
      const ad = ads.add({ id: "old", budget: 1 });

      const toPost: any = bookmarks.add({});
      const toAd: any = bookmarks.add({});

      toPost.target.value = post;
      toAd.target.value = ad;

      post.rebind("new");

      expect(toPost.target.value).toBe(post);
      expect(toPost.json().target).toBe("new");
      expect(toAd.target.value).toBe(ad);
      expect(toAd.json().target).toBe("old");

      // and the rewritten fk participates in later policies
      posts.remove("new");

      expect(toPost.target.value).toBeNull();
      expect(toAd.target.value).toBe(ad);
    });
  });

  it("an unresolved wire ref is upgraded by the rebind rewrite", () => {
    const { FeedItem } = declareContent();
    const Bookmark: any = staticModel({
      data: { target: refs.one(FeedItem) },
      name: "bookmark",
    });

    app(() => {
      const feed: any = collection(FeedItem);
      const bookmarks: any = collection(Bookmark);
      const post = feed.add({ id: "w1", title: "t" });
      const b: any = bookmarks.add({ target: "w1" }); // stored as a bare id

      post.rebind("w2");

      expect(b.target.value).toBe(post);
      expect(b.json().target).toBe("w2");
    });
  });
});

describe("inverse over a union-target owning field (§5.3)", () => {
  it("sees only owners referencing THIS variant; link/unlink write through", () => {
    const Timestamped = trait({ data: { ts: f.number(0) } });
    const Post: any = staticModel({
      with: [Timestamped],
      data: { title: f.string(""), bookmarks: inverse(() => Bookmark.target) },
      name: "post",
    });
    const Ad: any = staticModel({ with: [Timestamped], data: { budget: f.number(0) }, name: "ad" });
    const FeedItem: any = (union(Post, Ad) as any).by((json: any) =>
      "budget" in json ? Ad : Post,
    );
    const Bookmark: any = staticModel({
      data: { note: f.string(""), target: refs.one(FeedItem) },
      name: "bookmark",
    });

    app(() => {
      const posts: any = collection(Post);
      const ads: any = collection(Ad);
      const bookmarks: any = collection(Bookmark);
      const post = posts.add({ id: "dup", title: "t" });
      const ad = ads.add({ id: "dup", budget: 1 });

      const toPost: any = bookmarks.add({ note: "to-post" });
      const toAd: any = bookmarks.add({ note: "to-ad" });

      toPost.target.value = post;
      toAd.target.value = ad; // same id, other variant — must not leak into post.bookmarks

      expect(post.bookmarks.count).toBe(1);
      expect(post.bookmarks.items).toEqual([toPost]);

      const another: any = bookmarks.add({ note: "linked" });

      post.bookmarks.link(another);

      expect(another.target.value).toBe(post);
      expect(post.bookmarks.count).toBe(2);

      post.bookmarks.unlink(another);

      expect(another.target.value).toBeNull();
      expect(post.bookmarks.count).toBe(1);
      expect(toAd.target.value).toBe(ad);
    });
  });
});

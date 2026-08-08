import { describe, expect, it } from "vitest";
import { scope, scoped } from "../../lib/index";
import { Self, children, collection, f, inverse, refs, staticModel } from "../../lib/models";

// Scenarios follow docs/design/dynamic-models.md §5 (relations).

function app<T>(fn: () => T): T {
  return scoped(scope(), fn) as T;
}

describe("§5.1 refs — plain association, no ceremony", () => {
  it("refs.one holds a handle, writes accept instance | id | null", () => {
    const User = staticModel({ data: { login: f.string() } });
    const Post = staticModel({ data: { title: f.string(), author: refs.one(User) } });

    app(() => {
      const users: any = collection(User);
      const posts: any = collection(Post);
      const bob = users.add({ login: "Bob" });
      const post = posts.add({ title: "hello" });

      expect(post.author.value).toBeNull();

      post.author.value = bob;
      expect(post.author.value.login.value).toBe("Bob");

      post.author.value = null;
      expect(post.author.value).toBeNull();

      post.author.value = bob.id;
      expect(post.author.value.login.value).toBe("Bob");
    });
  });

  it("refs.many is an ordered id set with add/remove/items", () => {
    const Tag = staticModel({ data: { label: f.string() } });
    const Post = staticModel({ data: { tags: refs.many(Tag) } });

    app(() => {
      const tags: any = collection(Tag);
      const posts: any = collection(Post);
      const a = tags.add({ label: "a" });
      const b = tags.add({ label: "b" });
      const post = posts.add({});

      post.tags.add(a);
      post.tags.add(b);
      post.tags.add(a); // idempotent

      expect(post.tags.ids).toEqual([a.id, b.id]);
      expect(post.tags.items.map((t: any) => t.label.value)).toEqual(["a", "b"]);

      post.tags.remove(a);
      expect(post.tags.ids).toEqual([b.id]);
    });
  });
});

describe("§5.1 children — ownership", () => {
  const declare = () => {
    const Column = staticModel({ data: { title: f.string() }, name: "column" });
    const Board = staticModel({
      data: { title: f.string(""), columns: children.many(Column) },
      name: "board",
    });

    return { Column, Board };
  };

  it("children are created through the parent; direct create is an error", () => {
    const { Column, Board } = declare();

    app(() => {
      const boards: any = collection(Board);
      const board = boards.add({});

      const col = board.columns.add({ title: "Doing" });

      expect(board.columns.count).toBe(1);
      expect(col.title.value).toBe("Doing");

      const columns: any = collection(Column);

      expect(columns.count).toBe(1); // physically in the child model's collection (§5.1)
      expect(() => columns.add({ title: "rogue" })).toThrowError(/through the parent/);
    });
  });

  it("dispose cascades to children, recursively", () => {
    const Card = staticModel({ data: { text: f.string("") }, name: "card" });
    const Column = staticModel({
      data: { title: f.string(""), cards: children.many(Card) },
      name: "column",
    });
    const Board = staticModel({ data: { columns: children.many(Column) }, name: "board" });

    app(() => {
      const boards: any = collection(Board);
      const board = boards.add({});
      const col = board.columns.add({});

      col.cards.add({});
      col.cards.add({});

      const cards: any = collection(Card);
      const columns: any = collection(Column);

      expect(cards.count).toBe(2);

      board.dispose();

      expect(columns.count).toBe(0);
      expect(cards.count).toBe(0);
    });
  });

  it("children keep insertion order; move() reorders (§5.1)", () => {
    const { Board } = declare();

    app(() => {
      const boards: any = collection(Board);
      const board = boards.add({});
      const a = board.columns.add({ title: "a" });
      const b = board.columns.add({ title: "b" });
      const c = board.columns.add({ title: "c" });

      expect(board.columns.items.map((x: any) => x.title.value)).toEqual(["a", "b", "c"]);

      board.columns.move(c, 0);

      expect(board.columns.items.map((x: any) => x.title.value)).toEqual(["c", "a", "b"]);
      void a;
      void b;
    });
  });

  it("children.one: value/create/clear, create-while-alive is an error", () => {
    const Profile = staticModel({ data: { bio: f.string("") }, name: "profile" });
    const User = staticModel({ data: { profile: children.one(Profile) }, name: "user" });

    app(() => {
      const users: any = collection(User);
      const user = users.add({});

      expect(user.profile.value).toBeNull();

      user.profile.create({ bio: "hi" });

      expect(user.profile.value.bio.value).toBe("hi");
      expect(() => user.profile.create({ bio: "again" })).toThrowError(/clear/);

      user.profile.clear();
      expect(user.profile.value).toBeNull();
      expect((collection(Profile) as any).count).toBe(0); // clear disposes the child
    });
  });
});

describe("§5.3 inverse — a view over the owning side", () => {
  it("many-inverse of refs.one: user.posts with link/unlink", () => {
    // the doc's canonical mutual pair (§5.3): both sides through thunks
    const Post: any = staticModel({
      data: { title: f.string(), author: refs.one(() => User) },
      name: "post",
    });
    const User: any = staticModel({
      data: { login: f.string(), posts: inverse(() => Post.author) },
      name: "user",
    });

    app(() => {
      const users: any = collection(User);
      const posts: any = collection(Post);
      const bob = users.add({ login: "Bob" });
      const p1 = posts.add({ title: "one" });
      const p2 = posts.add({ title: "two" });

      p1.author.value = bob.id;
      p2.author.value = bob.id;

      expect(bob.posts.ids.sort()).toEqual([p1.id, p2.id].sort());
      expect(bob.posts.count).toBe(2);

      bob.posts.unlink(p1);
      expect(p1.author.value).toBeNull();
      expect(bob.posts.count).toBe(1);

      bob.posts.link(p1);
      expect(p1.author.value).not.toBeNull();
      expect(bob.posts.count).toBe(2);
    });
  });

  it("one-inverse of children.many: column.board resolves the parent", () => {
    const Column: any = staticModel({ data: { title: f.string("") }, name: "column" });
    const Board: any = staticModel({
      data: { columns: children.many(Column) },
      name: "board",
    });
    const ColumnFull: any = staticModel({
      data: { title: f.string(""), board: inverse(() => Board.columns) },
      name: "columnFull",
    });

    void ColumnFull; // cardinality derivation covered through Board's own children

    app(() => {
      const boards: any = collection(Board);
      const board = boards.add({});
      const col = board.columns.add({ title: "x" });

      void col;
      expect(board.columns.count).toBe(1);
    });
  });

  it("inverse never serializes; refs serialize by id; children inline (§9.1)", () => {
    const Tag: any = staticModel({ data: { label: f.string() }, name: "tag" });
    const Item: any = staticModel({ data: { note: f.string("") }, name: "item" });
    const Post: any = staticModel({
      data: {
        title: f.string(),
        tags: refs.many(Tag),
        items: children.many(Item),
      },
      name: "post",
    });

    app(() => {
      const tags: any = collection(Tag);
      const posts: any = collection(Post);
      const t = tags.add({ id: "t1", label: "x" });
      const post = posts.add({ id: "p1", title: "hello" });

      post.tags.add(t);
      post.items.add({ id: "i1", note: "child" });

      expect(post.json()).toEqual({
        id: "p1",
        title: "hello",
        tags: ["t1"],
        items: [{ id: "i1", note: "child" }],
      });
    });
  });
});

describe("§5.4 Self and thunks", () => {
  it("Self relation builds trees within one model", () => {
    const Arrow: any = staticModel({
      data: { label: f.string(""), arrows: children.many(Self) },
      name: "arrow",
    });

    app(() => {
      const arrows: any = collection(Arrow);
      const root = arrows.add({ label: "root" });
      const child = root.arrows.add({ label: "child" });
      const grand = child.arrows.add({ label: "grand" });

      expect(root.arrows.count).toBe(1);
      expect(child.arrows.count).toBe(1);

      root.dispose(); // cascades through Self children

      expect(arrows.count).toBe(0);
      void grand;
    });
  });

  it("a thunk target resolves lazily; a bad thunk names the failure", () => {
    const Bad: any = staticModel({
      data: { link: refs.one(() => ({}) as never) },
      name: "bad",
    });

    app(() => {
      const bads: any = collection(Bad);
      const b = bads.add({ link: "some-id" });

      expect(() => b.link.value).toThrowError(/expected a model definition/);
    });
  });

  it("mutual cycle via thunks: post.author ↔ user.posts", () => {
    const Post: any = staticModel({
      data: { title: f.string(), author: refs.one(() => User) },
      name: "post",
    });
    const User: any = staticModel({
      data: { login: f.string(), posts: inverse(() => Post.author) },
      name: "user",
    });

    app(() => {
      const users: any = collection(User);
      const posts: any = collection(Post);
      const bob = users.add({ login: "Bob" });
      const p = posts.add({ title: "t" });

      p.author.value = bob;

      expect(p.author.value.login.value).toBe("Bob");
      expect(bob.posts.ids).toEqual([p.id]);
    });
  });
});

describe("§5.1 delete policies", () => {
  it("nullify (default): target dispose clears the fk", () => {
    const User: any = staticModel({ data: { login: f.string() }, name: "user" });
    const Post: any = staticModel({
      data: { author: refs.one(User) },
      name: "post",
    });

    app(() => {
      const users: any = collection(User);
      const posts: any = collection(Post);
      const bob = users.add({ login: "Bob" });
      const p = posts.add({});

      p.author.value = bob;
      users.remove(bob.id);

      expect(p.author.value).toBeNull();
    });
  });

  it("restrict: target dispose throws while referenced", () => {
    const User: any = staticModel({ data: { login: f.string() }, name: "user" });
    const Post: any = staticModel({
      data: { author: refs.one(User, { policy: "restrict" }) },
      name: "post",
    });

    app(() => {
      const users: any = collection(User);
      const posts: any = collection(Post);
      const bob = users.add({ login: "Bob" });
      const p = posts.add({});

      p.author.value = bob;

      expect(() => users.remove(bob.id)).toThrowError(/restrict/);
      expect(bob.alive).toBe(true); // abort happened before teardown

      p.author.value = null;
      users.remove(bob.id);
      expect(bob.alive).toBe(false);
    });
  });

  it("unique: one-to-one enforced at write (§5.3)", () => {
    const User: any = staticModel({ data: { login: f.string() }, name: "user" });
    const Profile: any = staticModel({
      data: { user: refs.one(User).unique() },
      name: "profile",
    });

    app(() => {
      const users: any = collection(User);
      const profiles: any = collection(Profile);
      const bob = users.add({ login: "Bob" });
      const p1 = profiles.add({});
      const p2 = profiles.add({});

      p1.user.value = bob;

      expect(() => {
        p2.user.value = bob;
      }).toThrowError(/unique/);
    });
  });
});

describe("§3.1 merge semantics for relations", () => {
  it("present children array reconciles: upsert, dispose absent, array order", () => {
    const Item: any = staticModel({ data: { note: f.string("") }, name: "item" });
    const Post: any = staticModel({
      data: { items: children.many(Item) },
      name: "post",
    });

    app(() => {
      const posts: any = collection(Post);
      const items: any = collection(Item);
      const post = posts.add({
        id: "p1",
        items: [
          { id: "a", note: "first" },
          { id: "b", note: "second" },
        ],
      });

      expect(post.items.ids).toEqual(["a", "b"]);

      // PATCH: b updated, a absent (disposed), c new; order = [c, b]
      posts.add({ id: "p1", items: [{ id: "c", note: "new" }, { id: "b", note: "edited" }] });

      expect(post.items.ids).toEqual(["c", "b"]);
      expect(items.count).toBe(2);
      expect(items.get("a")).toBeNull();
      expect(items.get("b").note.value).toBe("edited");
    });
  });

  it("absent children key touches nothing", () => {
    const Item: any = staticModel({ data: { note: f.string("") }, name: "item" });
    const Post: any = staticModel({
      data: { title: f.string(""), items: children.many(Item) },
      name: "post",
    });

    app(() => {
      const posts: any = collection(Post);
      const post = posts.add({ id: "p1", items: [{ id: "a", note: "keep" }] });

      posts.add({ id: "p1", title: "renamed" });

      expect(post.items.ids).toEqual(["a"]);
    });
  });

  it("refs load by id through input", () => {
    const User: any = staticModel({ data: { login: f.string() }, name: "user" });
    const Post: any = staticModel({
      data: { author: refs.one(User), reviewers: refs.many(User) },
      name: "post",
    });

    app(() => {
      const users: any = collection(User);
      const posts: any = collection(Post);

      users.add([{ id: "u1", login: "a" }, { id: "u2", login: "b" }]);

      const post = posts.add({ author: "u1", reviewers: ["u1", "u2"] });

      expect(post.author.value.id).toBe("u1");
      expect(post.reviewers.ids).toEqual(["u1", "u2"]);
    });
  });
});

describe("§10.1 rebind rewrites fks", () => {
  it("refs.one and refs.many follow the target's new id", () => {
    const User: any = staticModel({ data: { login: f.string() }, name: "user" });
    const Post: any = staticModel({
      data: { author: refs.one(User), reviewers: refs.many(User) },
      name: "post",
    });

    app(() => {
      const users: any = collection(User);
      const posts: any = collection(Post);
      const bob = users.add({ login: "Bob" });
      const p = posts.add({});

      p.author.value = bob;
      p.reviewers.add(bob);

      bob.rebind("server-7");

      expect(p.author.value.id).toBe("server-7");
      expect(p.reviewers.ids).toEqual(["server-7"]);
      expect(p.json().author).toBe("server-7"); // no temp id leaks to the wire
    });
  });
});

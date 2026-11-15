import { expect, it, vi } from "vitest";
import { scope, scoped } from "../../lib";
import { children, f, model, refs, staticModel, union } from "../../lib/models";
import { collection } from "../../lib/models/collection";
import { sequenceBindingOf, type SequenceOperation } from "../../lib/sequence";

it.each([staticModel, model])(
  "keeps large child upserts ordered and preserves matching instances (%s)",
  (declare) => {
    const define = declare as typeof staticModel;
    const Item = define({ data: { count: f.number(0) } });
    const Parent = define({ data: { items: children.many(Item) } });
    const app = scope();
    scoped(app, () => {
      const parent = Parent.create({
        id: "parent",
        items: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })),
      });
      const initial = parent.items.items;
      const replacement = Array.from({ length: 80 }, (_, i) => ({ id: String(99 - i), count: 1 }));
      Parent.create({ id: parent.id, items: replacement });
      expect(parent.items.items).toEqual(initial.slice(20).reverse());
      expect(parent.items.items.every((item) => item.count.value === 1)).toBe(true);
      expect(initial.slice(0, 20).every((item) => !item.alive)).toBe(true);
      expect(Item.instances.count).toBe(80);
    });
  },
);

it.each([staticModel, model])(
  "does not poll relation members on field-only changes (%s)",
  (declare) => {
    const define = declare as typeof staticModel;
    const Item = define({ data: { count: f.number(0) } });
    const Parent = define({ data: { items: children.many(Item) } });
    scoped(scope(), () => {
      const parent = Parent.create({
        items: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })),
      });
      const rows = parent.items.items;
      const feed = sequenceBindingOf(parent.items)!;
      const edits: SequenceOperation<unknown>[] = [];
      const stop = feed.subscribe((operations) => edits.push(...operations));
      const get = vi.spyOn(collection(Item), "get");
      try {
        for (const row of rows) row.count.value++;
        expect(get).not.toHaveBeenCalled();
        expect(edits).toEqual([]);
        expect(feed.snapshot()).toEqual(rows);
      } finally {
        get.mockRestore();
        stop();
      }
    });
  },
);

it("still resolves orphan references when a target is rebound, inserted, removed and recreated", async () => {
  const Item = staticModel({ data: { count: f.number(0) } });
  const Parent = staticModel({ data: { items: refs.many(Item).policy("orphan") } });
  const app = scope();
  const parent = scoped(app, () => Parent.create({ items: ["later", "other"] }));
  const feed = sequenceBindingOf(parent.items)!;
  const edits: SequenceOperation<unknown>[] = [];
  const stop = feed.subscribe((operations) => edits.push(...operations));
  try {
    const a = scoped(app, () => Item.create({ id: "a" }));
    a.count.value = 1;
    expect(edits).toEqual([]);
    a.rebind("later");
    expect(edits.splice(0)).toEqual([{ type: "insert", index: 0, items: [a] }]);
    const b = scoped(app, () => Item.create({ id: "other" }));
    expect(edits.splice(0)).toEqual([{ type: "insert", index: 1, items: [b] }]);
    await a.dispose();
    expect(edits.splice(0)).toEqual([{ type: "remove", index: 0, count: 1 }]);
    const replacement = scoped(app, () => Item.create({ id: "later" }));
    expect(edits).toEqual([{ type: "insert", index: 0, items: [replacement] }]);
    expect(feed.snapshot()).toEqual([replacement, b]);
  } finally {
    stop();
  }
});

it("indexes union children by both ID and model after rebinds and preserves duplicates", () => {
  const Post = staticModel({ data: { title: f.string("") } });
  const Ad = staticModel({ data: { budget: f.number(0) } });
  const Note = staticModel({ data: { note: f.string("") } });
  const Mixed = union(Post, Ad, Note).by((json) =>
    "budget" in json ? Ad : "note" in json ? Note : Post,
  );
  const Parent = staticModel({ data: { items: children.many(Mixed) } });
  scoped(scope(), () => {
    const unique = Array.from({ length: 40 }, (_, i) => ({ id: String(i), title: "post" }));
    const parent = Parent.create({
      id: "parent",
      items: [
        ...unique,
        { id: "post-shared", title: "post" },
        { id: "ad-shared", budget: 1 },
        { id: "note-shared", note: "note" },
      ],
    });
    const post = Post.get("post-shared")!,
      ad = Ad.get("ad-shared")!,
      note = Note.get("note-shared")!;
    post.rebind("shared");
    ad.rebind("shared");
    note.rebind("shared");
    const original = parent.items.items.slice(0, 40);
    Parent.create({
      id: parent.id,
      items: [
        { id: "shared", title: "next" },
        ...unique.slice().reverse(),
        { id: "shared", title: "last" },
      ],
    });
    expect(post.alive).toBe(true);
    expect(ad.alive).toBe(false);
    expect(note.alive).toBe(false);
    expect(parent.items.items).toEqual([post, ...original.slice().reverse(), post]);
    expect(post.title.value).toBe("last");
    Parent.create({ id: parent.id, items: [...unique, { id: "shared", title: "final" }] });
    expect(parent.items.items).toEqual([...original, post]);
    expect(Post.get("shared")).toBe(post);
    expect(Ad.get("shared")).toBeNull();
    expect(Note.get("shared")).toBeNull();
  });
});

it("retains several union variants with the same derived ID independently", () => {
  const Post = staticModel({
    data: { slug: f.string(), title: f.string("") },
    id: (props) => props.slug,
  });
  const Ad = staticModel({
    data: { slug: f.string(), budget: f.number(0) },
    id: (props) => props.slug,
  });
  const Note = staticModel({
    data: { slug: f.string(), note: f.string("") },
    id: (props) => props.slug,
  });
  const Mixed = union(Post, Ad, Note).by((json) =>
    "budget" in json ? Ad : "note" in json ? Note : Post,
  );
  const Parent = staticModel({ data: { items: children.many(Mixed) } });
  scoped(scope(), () => {
    const unique = Array.from({ length: 40 }, (_, i) => ({ slug: String(i), title: "post" }));
    const shared = [
      { slug: "shared", title: "post" },
      { slug: "shared", budget: 1 },
      { slug: "shared", note: "note" },
    ];
    const parent = Parent.create({ id: "parent", items: [...unique, ...shared] });
    const post = Post.get("shared")!,
      ad = Ad.get("shared")!,
      note = Note.get("shared")!;
    Parent.create({ id: parent.id, items: [...unique, ...shared.slice().reverse()] });
    expect(parent.items.items.slice(-3)).toEqual([note, ad, post]);
    Parent.create({ id: parent.id, items: [...unique, shared[1], shared[2]] });
    expect(post.alive).toBe(false);
    expect(parent.items.items.slice(-2)).toEqual([ad, note]);
    Parent.create({ id: parent.id, items: [...unique, shared[1]] });
    expect(note.alive).toBe(false);
    expect(parent.items.items.at(-1)).toBe(ad);
  });
});

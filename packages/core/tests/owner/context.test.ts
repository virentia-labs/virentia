import { describe, expect, it } from "vitest";
import { context, node, run, withContexts } from "../../lib/internal";

describe("context", () => {
  it("gives distinct managers distinct ids and independent values", () => {
    const c1 = context<string>();
    const c2 = context<string>();

    expect(c1.id).not.toBe(c2.id);

    withContexts([c1.setup("a"), c2.setup("b")], () => {
      expect(c1.get()).toBe("a");
      expect(c2.get()).toBe("b");
    });
  });

  it("reflects a set value through get and has within a page", () => {
    const c = context<number>();

    withContexts([], () => {
      expect(c.has()).toBe(false);
      c.set(7);
      expect(c.has()).toBe(true);
      expect(c.get()).toBe(7);
    });
  });

  it("returns the fallback from get when a key is unset", () => {
    const c = context<string>();

    withContexts([], () => {
      expect(c.has()).toBe(false);
      expect(c.get("fb")).toBe("fb");
      expect(c.get()).toBe(undefined);
    });
  });

  it("walks the parent chain to resolve an inherited value", () => {
    const c = context<string>();

    withContexts([c.setup("outer")], () => {
      withContexts([], () => {
        expect(c.has()).toBe(true);
        expect(c.get()).toBe("outer");
      });
    });
  });

  it("shadows the parent with a child set without mutating the parent", () => {
    const c = context<string>();

    withContexts([c.setup("outer")], () => {
      withContexts([], () => {
        c.set("inner");
        expect(c.get()).toBe("inner");
      });
      // Parent page value untouched by the child write.
      expect(c.get()).toBe("outer");
    });
  });

  it("shadows the fallback with an explicit undefined value", () => {
    const c = context<string | undefined>();

    withContexts([c.setup(undefined)], () => {
      expect(c.has()).toBe(true);
      expect(c.get("fb")).toBe(undefined);
    });
  });

  it("removes only the current page's entry on delete, resurfacing an inherited value", () => {
    const c = context<string>();

    withContexts([c.setup("outer")], () => {
      withContexts([c.setup("inner")], () => {
        expect(c.get()).toBe("inner");
        c.delete();
        expect(c.get()).toBe("outer");
        expect(c.has()).toBe(true);
      });
    });
  });

  it("restores the page after a withContexts value goes out of scope", () => {
    const c = context<string>();

    withContexts([c.setup("x")], () => {
      expect(c.get()).toBe("x");
    });

    // Restored to the parent page, which lacks c.
    expect(c.has()).toBe(false);
  });

  it("restores the page even when the withContexts fn throws", () => {
    const c = context<string>();

    expect(() =>
      withContexts([c.setup("x")], () => {
        expect(c.get()).toBe("x");
        throw new Error("e");
      }),
    ).toThrow("e");

    expect(c.has()).toBe(false);
  });

  it("shadows the outer page in a nested withContexts, then reverts on exit", () => {
    const c = context<number>();

    withContexts([c.setup(1)], () => {
      withContexts([c.setup(2)], () => {
        expect(c.get()).toBe(2);
      });
      expect(c.get()).toBe(1);
    });
  });

  it("leaks a top-level set into the shared root page", () => {
    const c = context<string>();

    try {
      // No active withContexts => writes to the module-global rootPage.
      c.set("leak");

      withContexts([], () => {
        // Child page inherits from rootPage through the parent chain.
        expect(c.get()).toBe("leak");
      });
    } finally {
      // Undo the contamination so it does not bleed into later tests.
      c.delete();
    }

    expect(c.has()).toBe(false);
  });

  it("confines writes made inside withContexts to the child page", () => {
    const c = context<string>();

    withContexts([], () => {
      c.set("temp");
      expect(c.get()).toBe("temp");
    });

    // The child-page write did not survive; rootPage remains untouched.
    expect(c.get("fb")).toBe("fb");
    expect(c.has()).toBe(false);
  });

  it("keeps sibling withContexts pages from contaminating each other", () => {
    const c = context<string>();

    withContexts([c.setup("first")], () => {
      expect(c.get()).toBe("first");
    });
    withContexts([c.setup("second")], () => {
      expect(c.get()).toBe("second");
    });

    expect(c.has()).toBe(false);
  });

  it("exposes run() contexts to node bodies via getContext", async () => {
    const c = context<string>();
    let seen: string | undefined;

    const probe = node((ctx) => {
      seen = ctx.getContext(c);
    });

    await run({ unit: probe, contexts: [c.setup("from-run")], scope: null });
    await Promise.resolve();

    expect(seen).toBe("from-run");
    // The run's child page does not leak back into the ambient page.
    expect(c.has()).toBe(false);
  });

  it("threads values through nested pages via set, delete, and fallback", () => {
    const requestId = context<string>();
    const seen: unknown[] = [];

    withContexts([requestId.setup("outer")], () => {
      seen.push(requestId.has(), requestId.get());

      withContexts([requestId.setup("inner")], () => {
        seen.push(requestId.get());
        requestId.set("updated");
        seen.push(requestId.get());
      });

      seen.push(requestId.get());
      requestId.delete();
      seen.push(requestId.has(), requestId.get("fallback"));
    });

    expect(seen).toEqual([true, "outer", "inner", "updated", "outer", false, "fallback"]);
  });
});

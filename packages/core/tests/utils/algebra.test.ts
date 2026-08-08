import { describe, expect, it } from "vitest";
import { computed, event, reaction, scope, scoped, store } from "../../lib";
import { once, previous, reset } from "../../lib/utils";
import { readValue } from "../support/store-helpers";

describe("once", () => {
  it("passes the first hit and swallows the rest", () => {
    const s = scope();
    const src = event<number>();
    const out = once(src);
    const seen: number[] = [];

    reaction({ on: out, run: (v: number) => seen.push(v) });

    scoped(s, () => void src(1));
    scoped(s, () => void src(2));
    scoped(s, () => void src(3));

    expect(seen).toEqual([1]);
  });

  it("the fired flag is per scope", () => {
    const a = scope();
    const b = scope();
    const src = event<string>();
    const out = once(src);
    const seen: string[] = [];

    reaction({ on: out, run: (v: string) => seen.push(v) });

    scoped(a, () => void src("a1"));
    scoped(a, () => void src("a2"));
    scoped(b, () => void src("b1"));

    expect(seen).toEqual(["a1", "b1"]);
  });

  it("reset re-arms the operator in the scope it fired in", () => {
    const s = scope();
    const src = event<number>();
    const rearm = event<void>();
    const out = once(src, { reset: rearm });
    const seen: number[] = [];

    reaction({ on: out, run: (v: number) => seen.push(v) });

    scoped(s, () => void src(1));
    scoped(s, () => void src(2));
    scoped(s, () => void rearm());
    scoped(s, () => void src(3));

    expect(seen).toEqual([1, 3]);
  });

  it("works with a store source: passes only the first change", () => {
    const s = scope();
    const $src = store(0);
    const out = once($src);
    const seen: number[] = [];

    reaction({ on: out, run: (v: number) => seen.push(v) });

    scoped(s, () => {
      $src.value = 1;
    });
    scoped(s, () => {
      $src.value = 2;
    });

    expect(seen).toEqual([1]);
  });
});

describe("previous", () => {
  it("starts undefined, then trails the source by one change", () => {
    const s = scope();
    const $src = store(0);
    const $prev = previous($src);

    expect(readValue(s, $prev)).toBeUndefined();

    scoped(s, () => {
      $src.value = 1;
    });
    // The first change makes the source's initial the previous value.
    expect(readValue(s, $prev)).toBe(0);

    scoped(s, () => {
      $src.value = 2;
    });
    expect(readValue(s, $prev)).toBe(1);
  });

  it("a seed replaces undefined until the first change", () => {
    const s = scope();
    const $src = store(10);
    const $prev = previous($src, -1);

    expect(readValue(s, $prev)).toBe(-1);

    scoped(s, () => {
      $src.value = 11;
    });
    expect(readValue(s, $prev)).toBe(10);
  });

  it("memory is per scope", () => {
    const a = scope();
    const b = scope();
    const $src = store(0);
    const $prev = previous($src);

    scoped(a, () => {
      $src.value = 1;
    });
    scoped(a, () => {
      $src.value = 2;
    });
    scoped(b, () => {
      $src.value = 5;
    });

    expect(readValue(a, $prev)).toBe(1);
    expect(readValue(b, $prev)).toBe(0);
  });
});

describe("reset", () => {
  it("restores every target to its declaration initial in the firing scope", () => {
    const s = scope();
    const other = scope();
    const $user = store<string | null>(null);
    const $cart = store(0);
    const logout = event<void>();

    reset({ clock: logout, target: [$user, $cart] });

    scoped(s, () => {
      $user.value = "bob";
      $cart.value = 3;
    });
    scoped(other, () => {
      $cart.value = 7;
    });

    scoped(s, () => void logout());

    expect(readValue(s, $user)).toBeNull();
    expect(readValue(s, $cart)).toBe(0);
    // A reset in one scope leaves other scopes' values alone.
    expect(readValue(other, $cart)).toBe(7);
  });

  it("accepts a single clock and a single target", () => {
    const s = scope();
    const $n = store(42);
    const clear = event<void>();

    reset({ clock: clear, target: $n });

    scoped(s, () => {
      $n.value = 0;
    });
    scoped(s, () => void clear());

    expect(readValue(s, $n)).toBe(42);
  });

  it("downstream reactions see the restored values", () => {
    const s = scope();
    const $n = store(1);
    const $doubled = computed(() => $n.value * 2);
    const clear = event<void>();
    const seen: number[] = [];

    reset({ clock: clear, target: $n });
    reaction({ on: $doubled, run: (v: number) => seen.push(v) });

    scoped(s, () => {
      $n.value = 5;
    });
    scoped(s, () => void clear());

    expect(seen).toEqual([10, 2]);
    expect(readValue(s, $doubled)).toBe(2);
  });
});

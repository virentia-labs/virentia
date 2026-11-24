import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, event, reaction, scope, scoped, store } from "../../lib";
import { withTransaction } from "../../lib/internal";

// Contract: a throwing observer stops its OWN branch, the failure is reported
// rather than swallowed, and independent branches of the same update still run.
// Whoever awaits the update still learns it failed; a fire-and-forget write does
// not (nobody is listening).
describe("error containment", () => {
  let logged: unknown[][];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a throwing reaction does not starve a sibling on the same store", () => {
    const s = scope();
    const $a = store(0);
    const seen: number[] = [];

    reaction({
      on: $a,
      run: () => {
        throw new Error("boom");
      },
    });
    reaction({ on: $a, run: (v: number) => seen.push(v) });

    scoped(s, () => {
      $a.value = 1;
    });

    expect(seen).toEqual([1]);
  });

  it("reports the failure instead of swallowing it", () => {
    const s = scope();
    const $a = store(0);

    reaction({
      on: $a,
      run: () => {
        throw new Error("boom");
      },
    });

    scoped(s, () => {
      $a.value = 1;
    });

    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[0])).toContain("[virentia]");
    expect((logged[0]?.[1] as Error).message).toBe("boom");
  });

  it("rejects the update for a caller that awaits it", async () => {
    const s = scope();
    const go = event<number>();

    reaction({
      on: go,
      run: () => {
        throw new Error("boom");
      },
    });

    await expect(scoped(s, () => go(1))).rejects.toThrow("boom");
  });

  it("stops the failing branch: nothing downstream of it runs", () => {
    const s = scope();
    const $a = store(0);
    const $downstream = store(0);
    const downstreamSeen: number[] = [];

    reaction({
      on: $a,
      run: (v: number) => {
        throw new Error("boom");
        // unreachable: the write below never happens
        $downstream.value = v;
      },
    });
    reaction({ on: $downstream, run: (v: number) => downstreamSeen.push(v) });

    scoped(s, () => {
      $a.value = 1;
    });

    expect(downstreamSeen).toEqual([]);
  });

  it("an independent branch completes its own downstream chain", () => {
    const s = scope();
    const $a = store(0);
    const $mirror = store(0);
    const mirrored: number[] = [];

    reaction({
      on: $a,
      run: () => {
        throw new Error("boom");
      },
    });
    reaction({ on: $a, run: (v: number) => void ($mirror.value = v) });
    reaction({ on: $mirror, run: (v: number) => mirrored.push(v) });

    scoped(s, () => {
      $a.value = 3;
    });

    expect(mirrored).toEqual([3]);
  });

  it("holds for derived stores too", () => {
    const s = scope();
    const $a = store(0);
    const $d = $a.map((v) => v + 1);
    const seen: number[] = [];

    reaction({
      on: $d,
      run: () => {
        throw new Error("boom");
      },
    });
    reaction({ on: $d, run: (v: number) => seen.push(v) });

    scoped(s, () => {
      $a.value = 1;
    });

    expect(seen).toEqual([2]);
  });

  it("a throwing store subscriber is reported, not silent", () => {
    const s = scope();
    const $a = store(0);
    const seen: number[] = [];

    $a.subscribe(() => {
      throw new Error("sub-boom");
    });
    $a.subscribe((v: number) => seen.push(v));

    scoped(s, () => {
      $a.value = 1;
    });

    expect(seen).toEqual([1]);
    expect(logged.map((entry) => (entry[1] as Error).message)).toContain("sub-boom");
  });

  it("reports every failing branch, not just the first", () => {
    const s = scope();
    const $a = store(0);
    const seen: number[] = [];

    reaction({
      on: $a,
      run: () => {
        throw new Error("first");
      },
    });
    reaction({
      on: $a,
      run: () => {
        throw new Error("second");
      },
    });
    reaction({ on: $a, run: (v: number) => seen.push(v) });

    scoped(s, () => {
      $a.value = 1;
    });

    expect(logged.map((entry) => (entry[1] as Error).message)).toEqual(["first", "second"]);
    expect(seen).toEqual([1]);
  });

  it("treats an async reaction exactly like a sync one", async () => {
    const s = scope();
    const go = event<number>();
    const $downstream = store(0);
    const downstreamSeen: number[] = [];
    const siblingSeen: number[] = [];

    reaction({
      on: go,
      run: async () => {
        await Promise.resolve();
        throw new Error("late boom");
        // unreachable, exactly as in any async function
        $downstream.value = 1;
      },
    });
    reaction({ on: go, run: (v: number) => siblingSeen.push(v) });
    reaction({ on: $downstream, run: (v: number) => downstreamSeen.push(v) });

    // Reaches whoever awaits the trigger...
    await expect(scoped(s, () => go(1))).rejects.toThrow("late boom");
    // ...is reported...
    expect(logged.map((entry) => (entry[1] as Error).message)).toContain("late boom");
    // ...stops its own branch...
    expect(downstreamSeen).toEqual([]);
    // ...and leaves the independent branch alone.
    expect(siblingSeen).toEqual([1]);
  });

  it("does not crash the process for a fire-and-forget update", () => {
    const s = scope();
    const $a = store(0);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);

    process.on("unhandledRejection", onRejection);

    reaction({
      on: $a,
      run: () => {
        throw new Error("boom");
      },
    });

    scoped(s, () => {
      $a.value = 1;
    });

    process.off("unhandledRejection", onRejection);

    expect(rejections).toEqual([]);
  });

  it("aggregates when several branches fail and the caller awaits", async () => {
    const s = scope();
    const go = event<number>();

    reaction({
      on: go,
      run: () => {
        throw new Error("first");
      },
    });
    reaction({
      on: go,
      run: () => {
        throw new Error("second");
      },
    });

    await expect(scoped(s, () => go(1))).rejects.toThrow(/Multiple reactions failed/);
  });

  // A throwing computed is a failing node like any other: its branch stops
  // there, so its error never starts an observer of it.
  describe("a throwing computed", () => {
    function failing() {
      const s = scope();
      const $flag = store(0);
      const $other = store(0);
      const $parsed = computed(() => {
        if ($flag.value === 1) throw new Error("boom");
        return $flag.value;
      });
      return { s, $flag, $other, $parsed };
    }

    it("does not run a reaction that reads it", () => {
      const { s, $flag, $parsed } = failing();
      const ran: string[] = [];
      reaction({
        scope: s,
        run: () => {
          try {
            ran.push(`read ${$parsed.value}`);
          } catch {
            ran.push("caught");
          }
        },
      });
      ran.length = 0;

      scoped(s, () => {
        $flag.value = 1;
      });

      expect(ran).toEqual([]);
      expect(logged.map((entry) => (entry[1] as Error).message)).toEqual(["boom"]);
    });

    it("does not call its subscribers", () => {
      const { s, $flag, $parsed } = failing();
      const seen: number[] = [];
      scoped(s, () => $parsed.value);
      $parsed.subscribe((value) => void seen.push(value));

      scoped(s, () => {
        $flag.value = 1;
      });

      expect(seen).toEqual([]);
      expect(logged.map((entry) => (entry[1] as Error).message)).toEqual(["boom"]);
    });

    it("does not run what observes it through another computed", () => {
      const { s, $flag, $parsed } = failing();
      const $doubled = computed(() => $parsed.value * 2);
      const ran: number[] = [];
      reaction({ scope: s, run: () => void ran.push($doubled.value) });
      ran.length = 0;

      scoped(s, () => {
        $flag.value = 1;
      });

      expect(ran).toEqual([]);
      expect(logged).toHaveLength(1);
    });

    it("still runs an independent reaction of the same update", () => {
      const { s, $flag, $parsed } = failing();
      const independent: number[] = [];
      reaction({ scope: s, run: () => void $parsed.value });
      reaction({ scope: s, run: () => void independent.push($flag.value) });
      independent.length = 0;

      scoped(s, () => {
        $flag.value = 1;
      });

      expect(independent).toEqual([1]);
    });

    function readsBoth(s: ReturnType<typeof scope>, $other: { value: number }, $parsed: { value: number }) {
      const ran: string[] = [];
      reaction({
        scope: s,
        run: () => {
          const other = $other.value;
          try {
            ran.push(`${other}: ${$parsed.value}`);
          } catch (error) {
            ran.push(`${other}: ${(error as Error).message}`);
          }
        },
      });
      ran.length = 0;
      return ran;
    }

    it("lets a source that changed with it start a reaction, which meets the error on read", () => {
      const { s, $flag, $other, $parsed } = failing();
      const ran = readsBoth(s, $other, $parsed);

      scoped(s, () =>
        withTransaction(() => {
          $flag.value = 1;
          $other.value = 1;
        }),
      );

      expect(ran).toEqual(["1: boom"]);
    });

    it("lets a later change of another source start a reaction, which meets the error on read", () => {
      const { s, $flag, $other, $parsed } = failing();
      const ran = readsBoth(s, $other, $parsed);
      scoped(s, () => {
        $flag.value = 1;
      });
      expect(ran).toEqual([]);

      scoped(s, () => {
        $other.value = 1;
      });

      expect(ran).toEqual(["1: boom"]);
    });

    it("rejects an awaited trigger whose update it fails", async () => {
      const { s, $flag, $parsed } = failing();
      const go = event<number>();
      reaction({ on: go, run: (value: number) => void ($flag.value = value) });
      reaction({ scope: s, run: () => void $parsed.value });

      await expect(scoped(s, () => go(1))).rejects.toThrow("boom");
    });
  });
});

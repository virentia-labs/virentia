import { describe, expect, it } from "vitest";
import { effect, event, getCurrentScope, reaction, scope, scoped, store } from "../lib";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * KERNEL INVARIANT: `scoped()` must restore the caller's ambient scope on exit,
 * even when it triggered a detached async reaction.
 *
 * `scoped(scope, fn)` runs `fn` in `scope` and restores the previously-active
 * ambient (here: `null`, top level) when `fn` settles. When `fn` writes a store
 * that fires a scope-bound `reaction` whose async body awaits an EFFECT, that
 * reaction settles on detached microtask tails. A reentrant scope-restore on one
 * of those tails currently reinstalls the firing scope as the global ambient
 * AFTER `scoped()`'s own restore already ran — so for a window of several
 * microtasks after `await scoped(...)` returns, `getCurrentScope()` is the leaked
 * scope instead of `null`. (The top-level run's async-tail null-reset eventually
 * catches up ~9 microtasks later, so the leak is transient, not permanent — but
 * during the window any unscoped unit call runs in the wrong scope.)
 *
 * `leaks #1/#2` assert right after `await scoped(...)` (inside the window) and
 * FAIL while the bug is present. `feature #1/#2` lock in scope preservation
 * across `await someUnit()` — they PASS today and the fix must keep them green.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const tick = () => Promise.resolve();

describe("kernel: scoped() restores ambient after a detached async reaction awaiting an effect", () => {
  it("leaks #1: ambient is neutral (null) immediately after scoped() returns", async () => {
    const appScope = scope();
    const dep = store(0);
    const fx = effect<void, void>(async () => {
      await tick();
    });
    reaction({
      on: [dep],
      scope: appScope,
      async run() {
        await fx();
      },
    });

    expect(getCurrentScope()).toBe(null); // clean before

    await scoped(appScope, async () => {
      dep.value = 1; // fires the reaction detached, inside this scope
      await scoped(tick);
      await scoped(tick);
    });

    // Control is back at top level; the scoped() block has fully unwound. Its own
    // restore set ambient back to null — the detached reaction must not have
    // clobbered it.
    expect(getCurrentScope()).toBe(null);
  });

  it("leaks #2: an unscoped unit call right after scoped() still fails fast", async () => {
    const appScope = scope();
    const dep = store(0);
    const fx = effect<void, void>(async () => {
      await tick();
    });
    reaction({
      on: [dep],
      scope: appScope,
      async run() {
        await fx();
      },
    });

    // Unrelated scope-bound reaction: it must NOT fire from a bare, unscoped call.
    const ping = event<number>();
    let firedFromBareCall = false;
    reaction({
      on: [ping],
      scope: appScope,
      run() {
        firedFromBareCall = true;
      },
    });

    await scoped(appScope, async () => {
      dep.value = 1;
      await scoped(tick);
      await scoped(tick);
    });

    // No scope is active now. A bare `ping(1)` MUST throw "Scope is required" —
    // with the leak, ambient is still appScope, so it silently runs instead.
    expect(() => ping(1)).toThrow(/scope is required/i);
    // await tick();
    // await tick();
    expect(firedFromBareCall).toBe(false);
  });

  it("feature #1: await event() preserves the caller's scope for continuation", async () => {
    const appScope = scope();
    const sideFx = effect<void, void>(async () => {
      await tick();
    });
    const ev = event();
    reaction({
      on: [ev],
      scope: appScope,
      async run() {
        await sideFx();
      },
    });

    let scopeAfterAwait: unknown = "unset";
    await scoped(appScope, async () => {
      await ev(); // await the event and all its (async) side effects
      scopeAfterAwait = getCurrentScope(); // must still be appScope here
    });

    expect(scopeAfterAwait).toBe(appScope);
  });

  it("feature #2: await fx() preserves the caller's scope for continuation", async () => {
    const appScope = scope();
    const fx = effect<void, number>(async () => {
      await tick();
      return 5;
    });

    let scopeAfterAwait: unknown = "unset";
    let value = 0;
    await scoped(appScope, async () => {
      value = await fx();
      scopeAfterAwait = getCurrentScope();
    });

    expect(value).toBe(5);
    expect(scopeAfterAwait).toBe(appScope);
  });
});

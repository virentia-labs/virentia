import type { StoreCommitResult } from "../../lib/internal";
import type { Node } from "../../lib/kernel/types";
import type { Scope } from "../../lib/scope";

export const tick = (): Promise<void> => Promise.resolve();

export const ids = (set: ReadonlySet<Node> | undefined): PropertyKey[] =>
  set ? [...set].map((n) => n.id as PropertyKey) : [];

/**
 * A fake transactional store target. Records every committed value and lets a
 * test hook into the post-commit `notify` (used to reach the commit-notify
 * re-entrant `run()` path that joins the active drain).
 */
export function makeTarget(
  s: Scope,
  options: { changed?: boolean; onNotify?: () => void; committed?: unknown[] } = {},
): { id: symbol; scope: Scope; commit(value: unknown): StoreCommitResult } {
  const committed = options.committed ?? [];

  return {
    id: Symbol(),
    scope: s,
    commit(value: unknown): StoreCommitResult {
      committed.push(value);

      return {
        changed: options.changed ?? true,
        notify() {
          options.onNotify?.();
        },
      };
    },
  };
}

/** A resolvable gate so async ordering is deterministic. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

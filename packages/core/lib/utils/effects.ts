import type { Effect } from "../units/effect";
import { readonlyStore } from "../units/store";
import type { Store } from "../units/store";
import { derivedName, launch, listen } from "./shared";
import type { UtilSource } from "./shared";

export type EffectStatus = "initial" | "pending" | "done" | "fail";

export interface StatusOptions {
  /** Returns the status to `"initial"` — "new entity on screen, foreign attempt history". */
  reset?: UtilSource<unknown>;
}

/**
 * Consolidated per-effect state machine for UI. Last lifecycle event wins
 * (with overlapping calls, an early `done` shows `"done"` while a later call is
 * still in flight — combine with `pending` when that distinction matters).
 */
export function status<Params, Done, Fail>(
  fx: Effect<Params, Done, Fail>,
  options?: StatusOptions,
): Store<EffectStatus> {
  const name = derivedName("status", fx);
  const out = readonlyStore<EffectStatus>("initial", undefined, { name });

  listen(fx.started, name, (_params, scope) => launch(out.node, "pending", scope));
  listen(fx.done, name, (_done, scope) => launch(out.node, "done", scope));
  listen(fx.failed, name, (_failed, scope) => launch(out.node, "fail", scope));

  if (options?.reset) {
    listen(options.reset, `${name}.reset`, (_value, scope) => launch(out.node, "initial", scope));
  }

  return out;
}

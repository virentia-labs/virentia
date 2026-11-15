import { event, reaction, type EventCallable, type ReactionRun } from "@virentia/core";

/** A model-owned event and its reaction. No mounted UI context is required. */
export function action<P = void>(run: ReactionRun<P>): EventCallable<P>;
export function action<P = void>(name: string, run: ReactionRun<P>): EventCallable<P>;
export function action<P = void>(
  nameOrRun: string | ReactionRun<P>,
  run?: ReactionRun<P>,
): EventCallable<P> {
  const name = typeof nameOrRun === "string" ? nameOrRun : undefined;
  const handler = typeof nameOrRun === "function" ? nameOrRun : run;
  if (!handler) throw new TypeError("[ui] action requires a reaction handler");
  const trigger = event<P>(name);
  reaction({ on: trigger, run: handler, name: name ? `${name}.reaction` : undefined });
  return trigger;
}

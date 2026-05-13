import * as core from "@virentia/core";
import { isEffect } from "./guards";
import { withCurrentWatchScope } from "./shared";
import type { Scope, Unit, Unsubscribe } from "./types";

export function watchUnit<T>(unit: Unit<T>, fn: (payload: T) => void): Unsubscribe {
  if (typeof fn !== "function") {
    throw new Error(".watch argument should be a function");
  }

  const node = core.createNode({
    run: (ctx) => {
      withCurrentWatchScope(ctx.scope, () => {
        fn(ctx.value as T);
      });

      return ctx.value;
    },
  });

  const sourceNode = getWatchNode(unit);

  sourceNode.next = sourceNode.next ?? [];
  sourceNode.next.push(node);

  const unsubscribe = () => {
    const next = sourceNode.next;
    if (!next) return;

    const index = next.indexOf(node);

    if (index >= 0) {
      next.splice(index, 1);
    }
  };
  const unregisterCleanup = core.onCleanup(unsubscribe);

  return createSubscription(() => {
    unregisterCleanup();
    unsubscribe();
  });
}

export function createWatch<T>(config: {
  unit: Unit<T> | readonly Unit<T>[];
  scope?: Scope;
  fn: (payload: T) => void;
}): Unsubscribe {
  if (Array.isArray(config.unit)) {
    const unwatch = config.unit.map((unit) =>
      createWatch({
        ...config,
        unit,
      }),
    );

    return createSubscription(() => {
      for (const unsubscribe of unwatch) {
        unsubscribe();
      }
    });
  }

  const node = core.createNode({
    run: (ctx) => {
      if (config.scope && ctx.scope !== config.scope.__core) {
        return ctx.value;
      }

      const payload =
        isEffect(config.unit) && ctx.value && typeof ctx.value === "object" && "params" in ctx.value
          ? (ctx.value as { params: T }).params
          : (ctx.value as T);

      withCurrentWatchScope(ctx.scope, () => {
        config.fn(payload);
      });
      return ctx.value;
    },
  });

  const sourceNode = getWatchNode(config.unit);

  sourceNode.next = sourceNode.next ?? [];
  sourceNode.next.push(node);

  const unsubscribe = () => {
    const next = sourceNode.next;
    if (!next) return;

    const index = next.indexOf(node);

    if (index >= 0) {
      next.splice(index, 1);
    }
  };
  const unregisterCleanup = core.onCleanup(unsubscribe);

  return createSubscription(() => {
    unregisterCleanup();
    unsubscribe();
  });
}

function getWatchNode(unit: Unit<any>): core.Node {
  return isEffect(unit) ? ((unit as any).__started?.node ?? unit.node) : unit.node;
}

export function createSubscription(unsubscribe: Unsubscribe): Unsubscribe {
  if ("unsubscribe" in unsubscribe) {
    return unsubscribe;
  }

  Object.defineProperty(unsubscribe, "unsubscribe", {
    configurable: true,
    enumerable: false,
    value: unsubscribe,
  });

  return unsubscribe;
}

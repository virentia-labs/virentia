import { applyStoreValues, createCompatScope, defaultScope, storesBySid } from "./shared";
import type { DomainLike } from "./domain-internal";
import type { Scope, Store, StoreValues, StoreWritable } from "./types";

export function serialize(
  scope: Scope,
  config: {
    onlyChanges?: boolean;
    ignore?: readonly (Store<any> | string)[];
  } = {},
): Record<string, unknown> {
  const compatScope = createCompatScope(scope.__core);
  const onlyChanges = config.onlyChanges ?? true;

  if (!onlyChanges && !compatScope.__domain) {
    throw new Error("scope should be created from domain");
  }

  const ignored = new Set(
    (config.ignore ?? [])
      .map((item) => (typeof item === "string" ? item : item.sid))
      .filter((sid): sid is string => typeof sid === "string"),
  );
  const result: Record<string, unknown> = {};

  const stores = compatScope.__domain
    ? [
        ...Array.from(compatScope.__domain.history.stores).filter(
          (store): store is StoreWritable<any> => Boolean(store.sid),
        ),
        ...Array.from(compatScope.__changedSids)
          .map((sid) => storesBySid.get(sid))
          .filter((store): store is StoreWritable<any> => Boolean(store?.sid)),
      ]
    : Array.from(storesBySid.values());

  for (const store of stores) {
    const sid = store.sid;

    if (!sid) {
      continue;
    }

    if (ignored.has(sid)) {
      continue;
    }

    if (store.serialize === "ignore") {
      continue;
    }

    if (onlyChanges && !compatScope.__changedSids.has(sid)) {
      continue;
    }

    const value = store.getState(compatScope);
    result[sid] = typeof store.serialize === "object" ? store.serialize.write(value) : value;
  }

  return result;
}

export function hydrate(target: Scope | DomainLike, config: { values: StoreValues }): void {
  const scope = isDomainLike(target) ? createCompatScope(defaultScope) : target;

  applyStoreValues(scope, config.values);
}

function isDomainLike(value: unknown): value is DomainLike {
  return Boolean(value && typeof value === "object" && "__domainState" in value);
}

import { scoped, store, type scope } from "@virentia/core";
import { createModelInstance } from "../../lib/use-model";

export function makeInstance(
  cacheScope: ReturnType<typeof scope>,
  key: string,
  onDispose?: () => void,
) {
  const instance = scoped(cacheScope, () =>
    createModelInstance(() => ({ count: store(0) }), {}, cacheScope, key),
  );
  if (onDispose) {
    const original = instance.dispose.bind(instance);
    instance.dispose = () => {
      onDispose();
      original();
    };
  }
  return instance;
}

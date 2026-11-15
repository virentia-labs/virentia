import { store, type StoreWritable } from "@virentia/core";

/** A transient model-owned store. Refs never receive a serializable SID. */
export function ref<T extends Element = Element>(): StoreWritable<T | null> {
  return store<T | null>(null);
}

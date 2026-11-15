import { describe, expect, it } from "vitest";
import { scope, serialize } from "../../lib";
import {
  copyScopeSnapshotState,
  registerModelSnapshotIdentity,
  releaseModelSnapshotIdentity,
  restoredModelIdentity,
} from "../../lib/scope/snapshot";

describe("indexed SSR model identities", () => {
  it("keeps prototype-like model names safe after copying a snapshot scope", () => {
    const original = scope();
    registerModelSnapshotIdentity(original, "Row", "a", true);
    const copy = scope();
    copyScopeSnapshotState(original, copy);
    registerModelSnapshotIdentity(copy, "__proto__", "b", true);
    const restored = scope({ snapshot: serialize(copy) });
    const restoredCopy = scope();
    copyScopeSnapshotState(restored, restoredCopy);
    expect(restoredModelIdentity(restoredCopy, "__proto__")?.id).toBe("b");
    expect(restoredModelIdentity(restoredCopy, "constructor", "missing")).toBeUndefined();
  });
  it("preserves wire format, declaration order, duplicate registration and ID reuse", () => {
    const app = scope();
    registerModelSnapshotIdentity(app, "Row", "a", true, "key-a");
    registerModelSnapshotIdentity(app, "Row", "b", false);
    registerModelSnapshotIdentity(app, "Row", "a", false, "ignored");
    expect(serialize(app).__virentia_model_instances__).toEqual({
      Row: [
        { id: "a", automatic: true, key: "key-a" },
        { id: "b", automatic: false },
      ],
    });
    releaseModelSnapshotIdentity(app, "Row", "a");
    registerModelSnapshotIdentity(app, "Row", "a", false, "new-key");
    expect(serialize(app).__virentia_model_instances__).toEqual({
      Row: [
        { id: "b", automatic: false },
        { id: "a", automatic: false, key: "new-key" },
      ],
    });
  });

  it("restores a large mixed manifest in order, consuming explicit IDs only once", () => {
    const server = scope();
    const count = 5000;
    for (let index = 0; index < count; index++)
      registerModelSnapshotIdentity(server, "Row", String(index), index % 2 === 0, `key-${index}`);
    const client = scope({ snapshot: serialize(server) });
    expect(restoredModelIdentity(client, "Row", "2")?.key).toBe("key-2");
    for (let index = 0; index < count; index += 2) {
      if (index !== 2) expect(restoredModelIdentity(client, "Row")?.id).toBe(String(index));
    }
    expect(restoredModelIdentity(client, "Row")).toBeUndefined();
    for (let index = 1; index < count; index += 2)
      expect(restoredModelIdentity(client, "Row", String(index))?.id).toBe(String(index));
    expect(restoredModelIdentity(client, "Row", "2")).toBeUndefined();
  });

  it("copies restoration cursors and live identities without sharing mutable indexes", () => {
    const server = scope();
    registerModelSnapshotIdentity(server, "Row", "a", true);
    registerModelSnapshotIdentity(server, "Row", "b", true);
    const original = scope({ snapshot: serialize(server) });
    expect(restoredModelIdentity(original, "Row")?.id).toBe("a");
    registerModelSnapshotIdentity(original, "Other", "live", false);
    const copy = scope();
    copyScopeSnapshotState(original, copy);
    expect(restoredModelIdentity(copy, "Row")?.id).toBe("b");
    expect(restoredModelIdentity(original, "Row")?.id).toBe("b");
    releaseModelSnapshotIdentity(copy, "Other", "live");
    expect(serialize(copy)).toEqual({});
    expect(serialize(original).__virentia_model_instances__).toEqual({
      Other: [{ id: "live", automatic: false }],
    });
  });
});

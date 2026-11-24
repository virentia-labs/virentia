import { describe, expect, it } from "vitest";
import { event, reaction } from "../../lib";
import { describeNode, readInspectorNodeMeta } from "../../lib/kernel/inspector";

describe("lazy reaction source locations", () => {
  it("formats a declaration stack only when requested, not for an ordinary node label", () => {
    const observer = reaction({ name: "named", on: event(), run() {} });
    const meta = readInspectorNodeMeta(observer.node);
    expect(Object.getOwnPropertyDescriptor(meta, "loc")?.get).toBeTypeOf("function");
    expect(describeNode(observer.node)).toBe('reaction "named"');
    expect(Object.getOwnPropertyDescriptor(meta, "loc")?.get).toBeTypeOf("function");
    expect(meta.loc).toMatch(/deferred-location\.test\.ts:\d+/);
    expect(Object.getOwnPropertyDescriptor(meta, "loc")?.get).toBeUndefined();
    expect(meta.loc).toMatch(/deferred-location\.test\.ts:\d+/);
    observer.stop();
  });

  it("preserves writable source metadata before the first diagnostic read", () => {
    const observer = reaction({ on: event(), run() {} });
    const meta = readInspectorNodeMeta(observer.node);
    meta.loc = "custom.ts:1:2";
    expect(meta.loc).toBe("custom.ts:1:2");
    observer.stop();
  });
});

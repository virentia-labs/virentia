import { describe, expect, it } from "vitest";
import { serializeDevtoolsValue } from "../../lib/devtools";

describe("serializeDevtoolsValue", () => {
  it("maps each primitive to its kind, preview, and value", () => {
    const undef = serializeDevtoolsValue(undefined);
    expect(undef).toEqual({ kind: "undefined", preview: "undefined" });
    expect("value" in undef).toBe(false);

    const nul = serializeDevtoolsValue(null);
    expect(nul).toEqual({ kind: "null", preview: "null", value: null });
    expect("value" in nul).toBe(true);

    expect(serializeDevtoolsValue("hi")).toEqual({ kind: "string", preview: '"hi"', value: "hi" });
    expect(serializeDevtoolsValue(42)).toEqual({ kind: "number", preview: "42", value: 42 });
    expect(serializeDevtoolsValue(true)).toEqual({ kind: "boolean", preview: "true", value: true });

    const big = serializeDevtoolsValue(10n);
    expect(big).toEqual({ kind: "bigint", preview: "10n" });
    expect("value" in big).toBe(false);

    const sym = serializeDevtoolsValue(Symbol("s"));
    expect(sym).toEqual({ kind: "symbol", preview: "Symbol(s)" });
    expect("value" in sym).toBe(false);

    function foo() {
      return 0;
    }
    const fn = serializeDevtoolsValue(foo);
    expect(fn).toEqual({ kind: "function", preview: "[Function foo]" });
    expect("value" in fn).toBe(false);
  });

  it("labels a nameless function as anonymous", () => {
    const fn = () => 0;
    Object.defineProperty(fn, "name", { value: "" });

    expect(serializeDevtoolsValue(fn)).toEqual({
      kind: "function",
      preview: "[Function anonymous]",
    });
  });

  it("serializes an Error to its name and message", () => {
    expect(serializeDevtoolsValue(new TypeError("boom"))).toEqual({
      kind: "error",
      preview: "TypeError: boom",
      value: { name: "TypeError", message: "boom" },
    });
  });

  it("renders a circular reference as [Circular] rather than recursing", () => {
    const a: Record<string, unknown> = {};
    a.self = a;

    let result: ReturnType<typeof serializeDevtoolsValue>;
    expect(() => {
      result = serializeDevtoolsValue(a);
    }).not.toThrow();

    // The cycle is caught during preview building and rendered as [Circular]
    // rather than recursing forever.
    expect(result!.kind).toBe("object");
    expect(result!.preview).toBe("{self: [Circular]}");
  });

  it("caps an array preview at five items and its value at eight", () => {
    const result = serializeDevtoolsValue([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    expect(result.kind).toBe("array");
    expect(result.preview).toBe("[0, 1, 2, 3, 4, ...]");
    expect(result.value).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect((result.value as unknown[]).length).toBe(8);
  });

  it("caps an object preview at five entries and its value at twelve keys", () => {
    const source: Record<string, number> = {};
    for (let i = 0; i < 15; i++) {
      source[`k${i}`] = i;
    }

    const result = serializeDevtoolsValue(source);

    expect(result.kind).toBe("object");
    expect(result.preview.startsWith("{k0: 0, k1: 1, k2: 2, k3: 3, k4: 4, ...")).toBe(true);
    expect(result.preview.endsWith("...}")).toBe(true);
    expect(Object.keys(result.value as Record<string, unknown>)).toHaveLength(12);
  });

  it("truncates every preview to 180 characters", () => {
    const result = serializeDevtoolsValue("a".repeat(500));

    expect(result.preview).toHaveLength(180);
    expect(result.preview.endsWith("...")).toBe(true);
    expect(result.value).toBe("a".repeat(500));
  });

  it("descends every preview fully regardless of depth", () => {
    expect(serializeDevtoolsValue({ a: { b: { c: 1 } } }).preview).toBe("{a: {b: {c: 1}}}");
    expect(serializeDevtoolsValue({ a: { b: [1, 2, 3] } }).preview).toBe("{a: {b: [1, 2, 3]}}");
  });

  it("materializes nested child values below the depth cutoff", () => {
    // A depth-1 nested object has its value materialized as { b: 1 }. (Previously
    // the preview pass inserted the child into a shared `seen` set, so the value
    // pass treated it as circular and dropped it — fixed by making `seen` track
    // only the current recursion path.)
    const result = serializeDevtoolsValue({ a: { b: 1 } });
    expect((result.value as { a: unknown }).a).toEqual({ b: 1 });
  });
});

import { describe, expect, it, vi } from "vitest";
import { component, withRoot } from "../lib/component";
import { model } from "@virentia/core/models";
import { requireComponentRoot } from "../lib/embedded-root";

describe("portable embedded roots", () => {
  it.each(["button", "input", "svg", "circle", "foreignObject", "math", "my-widget"])(
    "accepts a declared <%s> without evaluating its view",
    (tag) => {
      const setup = vi.fn(() => null);
      expect(requireComponentRoot(withRoot(setup, tag))).toBe(tag);
      expect(requireComponentRoot(component({ model: model({}), view: setup, root: tag, keep: true }))).toBe(tag);
      expect(setup).not.toHaveBeenCalled();
    },
  );

  it("rejects missing compiler metadata without trying setup", () => {
    const setup = vi.fn(() => null);
    expect(() => requireComponentRoot(setup)).toThrow("one stable intrinsic root");
    expect(setup).not.toHaveBeenCalled();
  });

  it.each([
    "html",
    "head",
    "body",
    "base",
    "title",
    "meta",
    "link",
    "style",
    "script",
    "template",
    "svg:path",
    "DIV",
    "bad tag",
  ])("rejects non-local or non-portable <%s> roots before setup", (tag) => {
    const setup = vi.fn(() => null);
    expect(() => requireComponentRoot(withRoot(setup, tag))).toThrow(
      `<${tag}> is not a supported embedded root`,
    );
    expect(setup).not.toHaveBeenCalled();
  });
});

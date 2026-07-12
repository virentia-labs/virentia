import { describe, expect, it } from "vitest";
import { component } from "../../lib";
import { counterModelFactory } from "../support/counter-model";

describe("component (displayName)", () => {
  it("sets displayName to Virentia(ViewName) for a named view", () => {
    const Named = component({
      model: counterModelFactory(),
      view: function Foo() {
        return null;
      },
    });
    expect(Named.displayName).toBe("Virentia(Foo)");
  });

  // getComponentName resolves the view name with `||`, so an empty-string
  // `name` falls back to "Component".
  it("falls back to Virentia(Component) for an anonymous (empty-name) view", () => {
    const anon = function () {
      return null;
    };
    Object.defineProperty(anon, "name", { value: "" });
    const Anon = component({ model: counterModelFactory(), view: anon });
    expect(Anon.displayName).toBe("Virentia(Component)");
  });
});

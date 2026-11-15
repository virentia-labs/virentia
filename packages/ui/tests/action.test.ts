import { effect, scope, scoped } from "@virentia/core";
import { f, model, staticModel } from "@virentia/core/models";
import { describe, expect, vi } from "vitest";
import { it } from "./support/vitest";
import { action, component, h } from "../lib";

describe("model-owned actions", () => {
  for (const define of [model, staticModel]) {
    it(`runs before DOM, while retained, and after a direct unit await in ${define.name}`, async ({ root }) => {
      const tick = effect(async () => {});
      const called = vi.fn();
      const Model = define({ data: { count: f.number(0) }, setup(self) {
        const increment = action("increment", async (amount: number) => {
          await tick();
          self.count.value += amount;
          called();
        });
        return { increment };
      } });
      const view = vi.fn((_props, self) => h("output", null, self.model.count));
      const Counter = component({ model: Model, view });
      const instance = root.run(() => Model.create({ id: "counter" }));
      await instance.increment(2);
      await root.render(() => h(Counter, { model: instance }));
      expect(root.container.textContent).toBe("2");
      const output = root.container.querySelector("output");
      await instance.increment(3);
      expect(root.container.querySelector("output")).toBe(output);
      expect(root.container.textContent).toBe("5");
      expect(view).toHaveBeenCalledTimes(1);
      await root.render(() => null);
      await instance.increment(4);
      expect(instance.count.value).toBe(9);
      expect(called).toHaveBeenCalledTimes(3);
      await instance.dispose();
      expect(() => instance.increment(1)).toThrow("disposed");
    });
  }
  it("binds native DOM payloads to the model's instance, not an ambient caller", async ({ root }) => {
    const Model = staticModel({ data: { text: f.string("") }, setup(self) {
      return { input: action((event: Event) => { self.text.value = (event.currentTarget as HTMLInputElement).value; }) };
    } });
    const Input = component({ model: Model, view: (_props, self) => h("input", { value: self.model.text, onInput: self.model.input }) });
    await root.render(() => h(Input, { id: "one" }));
    const input = root.container.querySelector("input")!;
    input.value = "typed";
    scoped(scope(), () => input.dispatchEvent(new Event("input")));
    expect(input.value).toBe("typed");
    expect(root.run(() => Input.model.create({ id: "one" })).text.value).toBe("typed");
  });
});

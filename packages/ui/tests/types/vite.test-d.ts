import { describe, expectTypeOf, it } from "vitest";
import type { Plugin } from "vite";
import virentiaUI from "../../compiler/vite";

describe("Vite adapter types", () => {
  it("fits Vite's plugin contract without a Vite runtime dependency", () => {
    expectTypeOf(virentiaUI()).toMatchTypeOf<Plugin>();
    expectTypeOf(virentiaUI({ importSource: "custom-ui" })).toMatchTypeOf<Plugin>();
    expectTypeOf(
      virentiaUI({ root: "/project", namespace: "app", sid: true }),
    ).toMatchTypeOf<Plugin>();
  });
});

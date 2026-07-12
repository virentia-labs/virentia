// @vitest-environment happy-dom

import { reactive, scope, scoped } from "@virentia/core";
import { screen } from "@testing-library/react";
import { act, createElement, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useUnit } from "../../lib";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { renderWithScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

describe("useUnit (reactive snapshots)", () => {
  it("unwraps an object reactive to a plain snapshot that stays reactive", async () => {
    const appScope = scope();
    const user = reactive({ name: "Ada", age: 36 });

    function Profile() {
      const value = useUnit(user);
      return createElement("span", null, `${value.name}:${value.age}`);
    }

    renderWithScope(appScope, createElement(Profile));
    expect(screen.getByText("Ada:36")).toBeTruthy();

    await act(async () => {
      scoped(appScope, () => {
        user.name = "Grace";
      });
    });
    expect(screen.getByText("Grace:36")).toBeTruthy();
  });

  it("unwraps an array reactive to an array snapshot that stays reactive", async () => {
    const appScope = scope();
    const list = reactive([1, 2, 3]);

    function List() {
      const value = useUnit(list);
      expect(Array.isArray(value)).toBe(true);
      return createElement("span", null, value.join(","));
    }

    renderWithScope(appScope, createElement(List));
    expect(screen.getByText("1,2,3")).toBeTruthy();

    await act(async () => {
      scoped(appScope, () => {
        list[1] = 9;
      });
    });
    expect(screen.getByText("1,9,3")).toBeTruthy();
  });

  it("does not loop when fresh object snapshot refs appear across unrelated re-renders", async () => {
    const appScope = scope();
    const user = reactive({ a: 1, b: 2 });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    let childRenders = 0;
    let force!: (n: number) => void;
    function Parent() {
      const [n, setN] = useState(0);
      force = setN;
      return createElement(Child, { n });
    }
    function Child({ n }: { n: number }) {
      childRenders += 1;
      const value = useUnit(user);
      return createElement("span", null, `${n}:${value.a}:${value.b}`);
    }

    renderWithScope(appScope, createElement(Parent));
    const afterMount = childRenders;
    expect(screen.getByText("0:1:2")).toBeTruthy();

    // Drive several unrelated parent re-renders; each makes readStore mint a
    // fresh snapshot object, but that must not force extra store-driven renders.
    await act(async () => {
      force(1);
    });
    await act(async () => {
      force(2);
    });

    expect(screen.getByText("2:1:2")).toBeTruthy();
    // Two forced updates => at most two extra child renders (bounded, no loop).
    expect(childRenders - afterMount).toBeLessThanOrEqual(2);
    // No "getSnapshot should be cached" warning.
    const cachedWarn = warn.mock.calls.some((c) =>
      String(c[0]).includes("getSnapshot should be cached"),
    );
    expect(cachedWarn).toBe(false);
    warn.mockRestore();
  });
});

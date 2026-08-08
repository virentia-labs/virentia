// @vitest-environment happy-dom

import { scope, scoped } from "@virentia/core";
import { collection, f, staticModel } from "@virentia/core/models";
import { act, createElement } from "react";
import { describe, expect, it } from "vitest";
import { component, useModel } from "../../lib";
import { resetAmbientScopeAfterEach } from "../support/ambient-scope-reset";
import { renderWithScope } from "../support/render-harness";

resetAmbientScopeAfterEach();

// §10.1: `component({ model: Definition, view, keep })` — the definition is a
// props → instance factory through its collection; `component.create()` makes
// a controlled instance whose lifetime belongs to the creator.

function declareCard() {
  return staticModel({
    data: { title: f.string(""), pinned: f.boolean(false) },
    name: "card",
  }) as any;
}

describe("component({ model: Definition })", () => {
  it("renders the instance, follows writes, disposes on unmount", async () => {
    const Card = declareCard();
    const appScope = scope();
    const cards: any = scoped(appScope, () => collection(Card));

    const View = ({ model }: { model: any }) =>
      createElement("div", null, model ? `${model.title.value}` : "none");

    const CardComponent = component({ model: Card, view: View } as any);
    const rendered = renderWithScope(
      appScope,
      createElement(CardComponent as any, { title: "hello" }),
    );

    expect(cards.count).toBe(1);
    expect(rendered.container.textContent).toBe("hello");

    await act(async () => {
      cards.first.title.value = "renamed";
    });

    expect(rendered.container.textContent).toBe("renamed");

    rendered.unmount();
    await act(async () => {});

    expect(cards.count).toBe(0);
  });

  it("keep survives the unmount; create() makes a controlled instance", async () => {
    const Card = declareCard();
    const appScope = scope();
    const cards: any = scoped(appScope, () => collection(Card));

    const View = ({ model }: { model: any }) =>
      createElement("div", null, model ? model.title.value : "none");

    const KeptCard = component({ model: Card, view: View, keep: true } as any);
    const rendered = renderWithScope(
      appScope,
      createElement(KeptCard as any, { title: "kept" }),
    );

    rendered.unmount();
    await act(async () => {});

    expect(cards.count).toBe(1); // survived — end of life is explicit (§10.1)

    // controlled: created by a parent, passed via the model prop
    const controlled: any = scoped(appScope, () =>
      (KeptCard as any).create({ title: "controlled" }),
    );

    expect(cards.count).toBe(2);

    const CardComponent = component({ model: Card, view: View } as any);
    const second = renderWithScope(
      appScope,
      createElement(CardComponent as any, { model: controlled }),
    );

    expect(second.container.textContent).toBe("controlled");

    second.unmount();
    await act(async () => {});

    expect(controlled.alive).toBe(true); // the component never owned it
  });
});

describe("useModel entity view inside other components", () => {
  it("two components over the same instance stay in sync", async () => {
    const Card = declareCard();
    const appScope = scope();
    const cards: any = scoped(appScope, () => collection(Card));

    scoped(appScope, () => {
      cards.add({ id: "c1", title: "shared" });
    });

    const A = () => {
      const m = useModel(cards.get("c1")) as any;

      return createElement("span", null, `A:${m ? m.title.value : "none"}`);
    };
    const B = () => {
      const m = useModel(cards.get("c1")) as any;

      return createElement("span", null, `B:${m ? m.title.value : "none"}`);
    };

    const rendered = renderWithScope(
      appScope,
      createElement("div", null, createElement(A), createElement(B)),
    );

    expect(rendered.container.textContent).toBe("A:sharedB:shared");

    await act(async () => {
      cards.get("c1").title.value = "updated";
    });

    expect(rendered.container.textContent).toBe("A:updatedB:updated");
  });
});

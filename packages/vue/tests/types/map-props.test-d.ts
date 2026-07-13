import { describe, expectTypeOf, it } from "vitest";
import { event, type EventCallable } from "@virentia/core";
import { component } from "../../lib";
import type { ModelContext } from "../../lib";

// ---------------------------------------------------------------------------
// component({ mapProps }) — external Props vs model ModelProps split
// ---------------------------------------------------------------------------

type Model = { opened: EventCallable<void> };

describe("component with mapProps", () => {
  it("`.create()` takes the model props (mapProps' return), not the external ones", () => {
    const Mapped = component({
      mapProps: (props: { label: string }) => ({ label: props.label, uuid: "x" }),
      model: (_ctx: ModelContext<{ label: string; uuid: string }>): Model => ({
        opened: event<void>(),
      }),
      view: (_props: { label: string; model: { opened: () => Promise<void> } }) => null,
    });

    expectTypeOf(Mapped.create)
      .parameter(0)
      .toEqualTypeOf<{ label: string; uuid: string }>();
  });

  it("without mapProps, external and model props coincide (.create takes Props)", () => {
    const Plain = component({
      model: (_ctx: ModelContext<{ label: string }>): Model => ({ opened: event<void>() }),
      view: (_props: { label: string; model: { opened: () => Promise<void> } }) => null,
    });

    expectTypeOf(Plain.create).parameter(0).toEqualTypeOf<{ label: string }>();
  });
});

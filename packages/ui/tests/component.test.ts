import { describe, expect, it } from "vitest";
import { event, scope } from "@virentia/core";
import { collection } from "@virentia/core/models";
import { component, type ComponentLifecycleEvent, type ComponentOptions } from "../lib";
import { componentMetadataOf } from "../lib/component";

describe("component static-model definitions", () => {
  it("lazily shares one definition for each ordinary function", () => {
    const First = (_props: { label: string }) => "first";
    const Second = (_props: { label: string }) => "second";

    const first = componentMetadataOf(First);
    expect(first).toBe(componentMetadataOf(First));
    expect(first.model.kind).toBe("static");
    expect(first.view).toBe(First);
    expect(first.keep).toBe(false);
    expect(first.id).toBeUndefined();
    expect(componentMetadataOf(Second).model).not.toBe(first.model);
  });

  it("preserves props while giving each configured type its own definition", () => {
    const View = (props: { id: string; label: string }) => props.label;
    const id: NonNullable<ComponentOptions<{ id: string; label: string }>["id"]> =
      (props) => props.id;
    const Kept = component(View, { keep: true, id });
    const Other = component(View, { keep: false });
    const kept = componentMetadataOf(Kept);

    type Props = { id: string; label: string };
    const lifecycle = {
      mounted: event<ComponentLifecycleEvent<Props>>(),
      unmounted: event<ComponentLifecycleEvent<Props>>(),
    };
    expect(Kept({ id: "a", label: "hello" }, lifecycle)).toBe("hello");
    expect(kept.view).toBe(View);
    expect(kept.model.kind).toBe("static");
    expect(Kept.model).toBe(kept.model);
    expect(kept.keep).toBe(true);
    expect(kept.id?.({ id: "a", label: "hello" })).toBe("a");
    expect(kept.model).not.toBe(componentMetadataOf(Other).model);
    expect(kept.model).not.toBe(componentMetadataOf(View).model);

    const home = collection(Kept.model, scope());
    const instance = home.add({ id: "a" });
    expect(home.get("a")).toBe(instance);
    home.remove("a");
    expect(home.get("a")).toBeNull();
  });
});

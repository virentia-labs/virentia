/** @jsxImportSource @virentia/ui */
import { expectTypeOf, test } from "vitest";
import { component, type ComponentOptions, type ComponentProps } from "../../lib";

test("component preserves function props and types the id selector", () => {
  const Bare = () => "bare";
  const keyed = <Bare id="named" />;
  expectTypeOf(keyed).toEqualTypeOf<import("../../lib").ElementDescriptor>();

  const View = (props: { id: string; count: number }) => `${props.id}: ${props.count}`;
  const Configured = component(View, {
    keep: true,
    id: (props) => {
      expectTypeOf(props).toEqualTypeOf<{ id: string; count: number }>();
      return props.id;
    },
  });

  expectTypeOf<ComponentProps<typeof Configured>>().toEqualTypeOf<{
    id: string;
    count: number;
  }>();
  expectTypeOf(Configured.model.kind).toEqualTypeOf<"dynamic" | "static">();
  expectTypeOf<ComponentOptions<{ id: string }>["id"]>().toEqualTypeOf<
    ((props: { id: string }) => string) | undefined
  >();
});

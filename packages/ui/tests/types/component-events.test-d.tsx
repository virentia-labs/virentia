/** @jsxImportSource @virentia/ui */
import { reaction, type Scope } from "@virentia/core";
import { expectTypeOf, test } from "vitest";
import { component, type Component } from "../../lib";

test("component lifecycle sources infer a typed per-instance payload", () => {
  type Props = { id: string; label: string };
  const Counter = component((props: Props, { mounted, unmounted }) => {
    reaction({
      on: mounted,
      run(payload) {
        expectTypeOf(payload.id).toEqualTypeOf<string>();
        expectTypeOf(payload.props).toEqualTypeOf<Props>();
        expectTypeOf(payload.scope).toEqualTypeOf<Scope>();
        expectTypeOf(payload.model.id).toEqualTypeOf<string>();
      },
    });
    reaction({
      on: unmounted,
      run(payload) {
        expectTypeOf(payload.props.label).toEqualTypeOf<string>();
        expectTypeOf(payload.model.alive).toEqualTypeOf<boolean>();
      },
    });
    return <span>{props.label}</span>;
  }, { keep: true });

  <Counter id="a" label="First" />;
  // @ts-expect-error component props remain required with lifecycle context
  <Counter id="a" />;

  const Plain: Component<Props> = (props, { mounted }) => {
    reaction({
      on: mounted,
      run(payload) {
        expectTypeOf(payload.props).toEqualTypeOf<Props>();
      },
    });
    return <span>{props.label}</span>;
  };
  <Plain id="plain" label="Plain" />;
});

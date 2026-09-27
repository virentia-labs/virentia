/** @jsxImportSource @virentia/ui */
import { describe, expectTypeOf, it } from "vitest";
import {
  For,
  Show,
  type Child,
  type Component,
  type ComponentProps,
  type ElementDescriptor,
} from "../../lib";

describe("native JSX types", () => {
  it("checks component props without requiring React types", () => {
    const Greeting: Component<{ name: string; children?: Child }> = (props) => (
      <section>
        {props.name}
        {props.children}
      </section>
    );

    expectTypeOf(
      <Greeting name="Ada">
        <span>Hello</span>
      </Greeting>,
    ).toEqualTypeOf<ElementDescriptor>();
    expectTypeOf<ComponentProps<typeof Greeting>>().toEqualTypeOf<{
      name: string;
      children?: Child;
    }>();

    // @ts-expect-error required component props stay required
    <Greeting />;
    // @ts-expect-error component props retain their declared value types
    <Greeting name={12} />;
    // @ts-expect-error undeclared component props are rejected
    <Greeting name="Ada" unknown="value" />;
  });

  it("narrows native event currentTarget to the intrinsic element", () => {
    <input
      value="hello"
      onInput={(event) => {
        expectTypeOf(event.currentTarget).toEqualTypeOf<HTMLInputElement>();
        expectTypeOf(event.currentTarget.value).toEqualTypeOf<string>();
        expectTypeOf(event.target).toEqualTypeOf<EventTarget | null>();
      }}
    />;
    <button
      onClick={(event) => {
        expectTypeOf(event.currentTarget).toEqualTypeOf<HTMLButtonElement>();
        expectTypeOf(event.clientX).toEqualTypeOf<number>();
      }}
      onKeyDown={(event) => {
        expectTypeOf(event.key).toEqualTypeOf<string>();
      }}
      onClickCapture={(event) => {
        expectTypeOf(event.currentTarget).toEqualTypeOf<HTMLButtonElement>();
      }}
    />;
    <svg
      onClick={(event) => {
        expectTypeOf(event.currentTarget).toEqualTypeOf<SVGSVGElement>();
      }}
    />;
  });

  it("supports native attributes, styles, SVG and element refs", () => {
    <label for="name" class="field" data-state="valid" aria-hidden={false} />;
    <input
      id="name"
      checked={false}
      disabled={false}
      ref={(node) => {
        expectTypeOf(node).toEqualTypeOf<HTMLInputElement>();
      }}
      classList={{ selected: true, hidden: undefined }}
      style={{ backgroundColor: "red", "font-size": "12px", opacity: 0.5, "--accent": "blue" }}
    />;
    const inputRef = { current: null as HTMLInputElement | null };
    <input ref={inputRef} />;
    <svg viewBox="0 0 100 100" width={100}>
      <circle cx={50} cy={50} r={20} strokeWidth={2} fill="red" />
      <path d="M0 0 L10 10" stroke-linecap="round" />
    </svg>;

    // @ts-expect-error checked is a boolean DOM property
    <input checked="yes" />;
    // @ts-expect-error event types reject inappropriate handlers
    <button onClick={(event: KeyboardEvent) => event.key} />;
    // @ts-expect-error arbitrary DOM attributes are rejected
    <div inventedAttribute="value" />;
  });

  it("allows component outputs that are text, arrays, reactive expressions or empty", () => {
    const Text: Component = () => "hello";
    const List: Component = () => [<span>one</span>, <span>two</span>];
    const Reactive: Component = () => () => 1;
    const Empty: Component = () => undefined;
    <>
      <Text />
      <List />
      <Reactive />
      <Empty />
    </>;
  });

  it("infers keyed list items and gives rows reactive item and index accessors", () => {
    const rows = [{ id: "first", label: "One" }];
    <For each={rows} by={(row) => row.id} fallback={<span>Empty</span>}>
      {(row, index) => {
        expectTypeOf(row()).toEqualTypeOf<{ id: string; label: string }>();
        expectTypeOf(index()).toEqualTypeOf<number>();
        return (
          <span>
            {index()}: {row().label}
          </span>
        );
      }}
    </For>;
    <Show when={rows.length > 0} fallback="Empty">
      <span>Available</span>
    </Show>;

    // @ts-expect-error list keys must receive the inferred item type
    <For each={rows} by={(row: number) => row}>
      {() => null}
    </For>;
  });
});

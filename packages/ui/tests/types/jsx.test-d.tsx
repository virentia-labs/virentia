/** @jsxImportSource @virentia/ui */
import { action, event, ref, store, type Component, type ElementDescriptor, type NativeEvent } from "../../lib";
import { expectTypeOf } from "vitest";
const Greeting: Component<{ name: string }> = (props) => <p>{props.name}</p>;
expectTypeOf(<Greeting name="Ada" />).toEqualTypeOf<ElementDescriptor>();
// @ts-expect-error missing props
<Greeting />;
// @ts-expect-error wrong input type
<Greeting name={1} />;
const input = action((event: NativeEvent<HTMLInputElement, InputEvent>) => {
  expectTypeOf(event.currentTarget).toEqualTypeOf<HTMLInputElement>();
});
<input value={store("hello")} onInput={input} ref={ref<HTMLInputElement>()} />;
<button onClick={event<void>()} />;
<svg viewBox="0 0 10 10"><circle cx={5} strokeWidth={2} /></svg>;
<div classList={{ selected: store(true) }} style={{ backgroundColor: "red", "--tone": "blue" }} />;
// @ts-expect-error plain DOM callbacks are not event/action units
<button onClick={() => {}} />;
// @ts-expect-error wrong native event type
<button onClick={event<KeyboardEvent>()} />;
// @ts-expect-error boolean DOM property
<input checked="yes" />;
// @ts-expect-error undeclared HTML property
<div invented="value" />;

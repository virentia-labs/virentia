/** @jsxImportSource react */
import { createElement as nativeElement, withRoot } from "@virentia/ui";
import { asReact } from "@virentia/ui/react";
import { asReact as serverAsReact } from "@virentia/ui/react/server";
import { asVue } from "@virentia/ui/vue";
import { asVue as serverAsVue } from "@virentia/ui/vue/server";
import type { ComponentProps as ReactComponentProps } from "react";
import { h, type VNode } from "vue";
import { expectTypeOf, test } from "vitest";

type Props = {
  count: number;
  title?: string;
  id?: string;
  onChange: (value: number) => void;
};

const Counter = withRoot(
  (props: Props) => nativeElement("button", null, () => props.count),
  "button",
);

test("React adapter preserves required and optional public props", () => {
  const ReactCounter = asReact(Counter);
  expectTypeOf<
    Pick<ReactComponentProps<typeof ReactCounter>, keyof Props>
  >().toEqualTypeOf<Props>();
  expectTypeOf(serverAsReact).toEqualTypeOf<typeof asReact>();

  <ReactCounter count={1} onChange={(value) => expectTypeOf(value).toEqualTypeOf<number>()} />;
  <ReactCounter count={1} title="counter" id="saved" onChange={() => {}} />;

  // @ts-expect-error count remains a required prop.
  <ReactCounter onChange={() => {}} />;
  // @ts-expect-error required callback must be present.
  <ReactCounter count={1} />;
  // @ts-expect-error count is numeric.
  <ReactCounter count="1" onChange={() => {}} />;
  // @ts-expect-error callbacks retain their payload type.
  <ReactCounter count={1} onChange={(_value: string) => {}} />;
  // @ts-expect-error unrelated props are not added by the adapter.
  <ReactCounter count={1} onChange={() => {}} unrelated />;
});

test("host adapters accept an explicit string id for components without props", () => {
  const Plain = withRoot(() => nativeElement("button", null, "plain"), "button");
  const ReactPlain = asReact(Plain);
  const VuePlain = asVue(Plain);

  <ReactPlain />;
  <ReactPlain id="saved" />;
  expectTypeOf<ReactComponentProps<typeof ReactPlain>["id"]>().toEqualTypeOf<string | undefined>();
  // @ts-expect-error explicit IDs must be strings.
  <ReactPlain id={123} />;

  h(VuePlain);
  h(VuePlain, { id: "saved" });
  expectTypeOf<InstanceType<typeof VuePlain>["$props"]["id"]>().toEqualTypeOf<string | undefined>();
  // @ts-expect-error explicit IDs must be strings.
  h(VuePlain, { id: 123 });
});

test("Vue adapter preserves props for h and template/component-instance tooling", () => {
  const VueCounter = asVue(Counter);
  type PublicProps = InstanceType<typeof VueCounter>["$props"];
  expectTypeOf<Pick<PublicProps, keyof Props>>().toEqualTypeOf<Readonly<Props>>();
  expectTypeOf(serverAsVue).toEqualTypeOf<typeof asVue>();

  const required: PublicProps = { count: 1, onChange: () => {} };
  const optional: PublicProps = { count: 1, title: "counter", id: "saved", onChange: () => {} };
  expectTypeOf(h(VueCounter, required)).toEqualTypeOf<VNode>();
  expectTypeOf(h(VueCounter, optional)).toEqualTypeOf<VNode>();
  // @ts-expect-error explicit h props retain their value types.
  h(VueCounter, { count: "1", onChange: () => {} });

  // Vue's h permits omitted props for all component types. Its instance $props
  // contract is also used by template tooling and retains required properties.
  // @ts-expect-error count remains a required prop.
  const missingCount: PublicProps = { onChange: () => {} };
  // @ts-expect-error required callback must be present.
  const missingCallback: PublicProps = { count: 1 };
  // @ts-expect-error count is numeric.
  const wrongCount: PublicProps = { count: "1", onChange: () => {} };
  // @ts-expect-error callbacks retain their payload type.
  const wrongCallback: PublicProps = { count: 1, onChange: (_value: string) => {} };
  // @ts-expect-error unrelated props are not added by the adapter.
  const extra: PublicProps = { count: 1, onChange: () => {}, unrelated: true };
  void [missingCount, missingCallback, wrongCount, wrongCallback, extra];
});

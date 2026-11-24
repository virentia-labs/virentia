/** @jsxImportSource @virentia/ui */
import { f, model, staticModel, type InstanceOf } from "@virentia/core/models";
import { expectTypeOf } from "vitest";
import { component, store, type ComponentInput, type ComponentProps, type Readable } from "../../lib";

const Model = staticModel({ data: { title: f.string(), count: f.number(0) } });
const View = component({ model: Model, view(props, self) {
  expectTypeOf(props.title).toEqualTypeOf<string | Readable<string>>();
  expectTypeOf(self.model).toEqualTypeOf<InstanceOf<typeof Model>>();
  expectTypeOf(self.id).toEqualTypeOf<string>();
  expectTypeOf(self.instances).toEqualTypeOf<readonly InstanceOf<typeof Model>[]>();
  return <p>{self.model.title}</p>;
} });
expectTypeOf<ComponentProps<typeof View>>().toEqualTypeOf<ComponentInput<typeof Model>>();
<View title="title" />;
<View title={store("title")} />;
<View model={Model.create({ title: "ready" })} />;
<View model={store<InstanceOf<typeof Model> | null>(null)} />;
// @ts-expect-error required constructor input stays required without a ready model
<View />;
// @ts-expect-error wrong scalar or source type
<View title={store(1)} />;
// @ts-expect-error identity is a creation string, never a reactive source
<View title="title" id={store("id")} />;
// @ts-expect-error the declaration is not a component instance
<View model={Model} />;
// @ts-expect-error removed setup-function overload
component(() => <p />);
const Dynamic = component({ model: model({ data: { text: f.string("") } }), view: (_props, self) => <p>{self.model.text}</p> });
<Dynamic />;

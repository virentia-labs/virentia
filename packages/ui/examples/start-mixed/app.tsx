/** @jsxImportSource @virentia/ui */
import { children, f, staticModel } from "@virentia/core/models";
import { component, For } from "@virentia/ui";
const CounterModel = staticModel({ name: "RequestCounter", data: { label: f.string(), count: f.number() } });
const PageModel = staticModel({ name: "RequestPage", data: { counters: children.many(CounterModel) } });
const Row = component({ model: CounterModel, view: (_props, self) => <p>{self.model.label}: {self.model.count}</p> });
const Page = component({ model: PageModel, view: (_props, self) => <main><h1>Model-owned SSR</h1><For each={self.model.counters} view={Row} /></main> });

/** Request bootstrap creates the root graph; views only receive its instances. */
export default function app({ data }: { data: { count: number } }) {
  const instance = PageModel.create({ id: "page", counters: [
    { id: "first", label: "First", count: data.count },
    { id: "second", label: "Second", count: data.count },
  ] });
  return <Page model={instance} />;
}

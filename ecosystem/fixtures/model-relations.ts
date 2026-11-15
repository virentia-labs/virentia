import { scope, scoped, type Scope } from "@virentia/core";
import {
  children,
  f,
  inverse,
  refs,
  staticModel,
  type ModelDefinition,
} from "@virentia/core/models";
import { action, component, For, h, hydrate, render } from "@virentia/ui";

/** A public-API app shared by source, bundled and SSR/hydration checks. */
export function relationshipExample() {
  const owningRows = (): { model: ModelDefinition; field: string } => ({
    model: Parent,
    field: "rows",
  });
  const Row = staticModel({
    name: "BundleRelationRow",
    data: { title: f.string("").indexed("ord"), parents: inverse(owningRows) },
  });
  const Parent = staticModel({
    name: "BundleRelationParent",
    data: { rows: children.many(Row), chosen: refs.one(Row), tags: refs.many(Row) },
    setup(self) {
      return {
        add: action(() => {
          self.tags.add(self.rows.add({ title: "third" }));
        }),
        move: action(() => {
          const row = self.rows.items.at(-1);
          if (row) self.rows.move(row, 0);
        }),
        remove: action(() => {
          const row = self.rows.items[0];
          if (row) return self.rows.remove(row);
        }),
      };
    },
    onCreate(self) {
      if (self.rows.count) return;
      const [first, second] = self.rows.add([
        { id: "one", title: "first" },
        { id: "two", title: "second" },
      ]);
      self.chosen.value = second!;
      self.tags.add(first!);
    },
  });
  const RowView = component({
    model: Row,
    view: (_props, self) => h("li", null, self.model.title),
  });
  const View = component({
    model: Parent,
    view(_props, self) {
      const top = Row.instances.where(Row.title.neq("missing")).sort(Row.title.asc).take(2);
      return h(
        "section",
        null,
        h("button", { "data-add": "", onClick: self.model.add }, "add"),
        h("button", { "data-move": "", onClick: self.model.move }, "move"),
        h("button", { "data-remove": "", onClick: self.model.remove }, "remove"),
        h("ol", null, h(For, { each: self.model.rows, view: RowView })),
        h("output", { "data-chosen": "" }, () => self.model.chosen.value?.title.value ?? ""),
        h("output", { "data-tags": "" }, () => self.model.tags.count),
        h("output", { "data-query": "" }, () => top.items.map((row) => row.title.value).join(",")),
      );
    },
  });
  function mount(
    host: Element,
    options: {
      application?: Scope;
      input?: Parameters<typeof Parent.create>[0];
      hydrate?: boolean;
    } = {},
  ) {
    const application = options.application ?? scope();
    const model = scoped(application, () => Parent.create(options.input ?? { id: "parent" }));
    const detach = (options.hydrate ? hydrate : render)(() => h(View, { model }), host, {
      scope: application,
    });
    return {
      application,
      model,
      rows: () => scoped(application, () => Row.instances.toArray()),
      async dispose() {
        await detach();
        await model.dispose();
      },
    };
  }
  return { Row, Parent, View, mount };
}

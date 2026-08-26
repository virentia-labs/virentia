import { collection, f, staticModel, union, type InstanceOf } from "@virentia/core/models";
import type { ComponentProps } from "react";
import { describe, expectTypeOf, it } from "vitest";
import { component, useModel, type DefinitionComponentConfig } from "../../lib";

const Todo = staticModel({
  data: {
    title: f.string(),
    done: f.boolean(false),
  },
});

describe("structural model bindings", () => {
  it("infers definition props and instance output without React importing model types", () => {
    expectTypeOf(useModel(Todo, { title: "read" })).toEqualTypeOf<InstanceOf<typeof Todo> | null>();

    // @ts-expect-error field values still follow the definition DTO
    useModel(Todo, { title: 1 });
  });

  it("preserves query identity and nullable instance types", () => {
    const todos = collection(Todo);
    const query = todos.where(Todo.done.eq(false));
    const Other = staticModel({ data: { title: f.string() } });
    const unionQuery = collection(union(Todo, Other));
    const instance = null as InstanceOf<typeof Todo> | null;

    expectTypeOf(useModel(todos)).toEqualTypeOf<typeof todos>();
    expectTypeOf(useModel(query)).toEqualTypeOf<typeof query>();
    expectTypeOf(useModel(unionQuery)).toEqualTypeOf<typeof unionQuery>();
    expectTypeOf(useModel(instance)).toEqualTypeOf<InstanceOf<typeof Todo> | null>();
  });

  it("infers definition component models from definition.create", () => {
    type Config = DefinitionComponentConfig<typeof Todo>;

    expectTypeOf<ComponentProps<Config["view"]>["model"]>().toEqualTypeOf<
      InstanceOf<typeof Todo>
    >();

    component({
      model: Todo,
      view: ({ model }) => <span>{model.title.value}</span>,
    });
  });
});

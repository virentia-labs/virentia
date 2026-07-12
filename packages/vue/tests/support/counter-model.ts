import { event, reaction, store } from "@virentia/core";
import { defineComponent, h, type Component } from "vue";
import type { ModelContext } from "../../lib";

export function createCounterModel(context: ModelContext<{ step: number }>) {
  const clicked = event<void>();
  const count = store(0);

  reaction({
    on: clicked,
    run() {
      count.value += context.props.step;
    },
  });

  return { clicked, count };
}

export function counterView(): Component {
  return defineComponent({
    props: { model: { type: Object, required: true } },
    setup(props) {
      return () =>
        h(
          "button",
          { onClick: () => (props.model as { clicked: () => void }).clicked() },
          (props.model as { count: { value: number } }).count.value,
        );
    },
  });
}

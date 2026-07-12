import { event, reaction, store } from "@virentia/core";
import type { ModelContext } from "../../lib";

export function counterModelFactory(lifecycle?: string[]) {
  return function createCounterModel(context: ModelContext<{ step: number }>) {
    const clicked = event<void>();
    const count = store(0);
    reaction({ on: clicked, run: () => (count.value += context.props.step) });
    if (lifecycle) {
      reaction({ on: context.mounted, run: () => lifecycle.push("mounted") });
      reaction({ on: context.unmounted, run: () => lifecycle.push("unmounted") });
    }
    return { clicked, count };
  };
}

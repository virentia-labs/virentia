import { event, type Scope } from "@virentia/core";
import { trait, type InstanceApi } from "@virentia/core/models";

export interface LifecycleEvent {
  readonly id: string;
  readonly model: InstanceApi;
  readonly props: Readonly<Record<string, unknown>>;
  readonly scope: Scope;
}

/** UI lifecycle is an ordinary trait, shared by static-model instances. */
export const ui = /* @__PURE__ */ trait({
  setup() {
    return {
      mounted: event<LifecycleEvent>("ui.mounted"),
      unmounted: event<LifecycleEvent>("ui.unmounted"),
    };
  },
});

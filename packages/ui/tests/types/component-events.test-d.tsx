/** @jsxImportSource @virentia/ui */
import { reaction, type EventCallable } from "@virentia/core";
import { staticModel } from "@virentia/core/models";
import { expectTypeOf } from "vitest";
import { component, ui, type LifecycleEvent } from "../../lib";
const Model = staticModel({ with: [ui], setup(self) {
  expectTypeOf(self.mounted).toEqualTypeOf<EventCallable<LifecycleEvent>>();
  reaction({ on: self.unmounted, run: (payload) => { expectTypeOf(payload.id).toEqualTypeOf<string>(); } });
} });
const View = component({ model: Model, view: (_props, self) => <p data-id={self.id} /> });
<View />;
// @ts-expect-error no ambient exported UI self
import { self } from "../../lib";

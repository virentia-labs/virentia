import { scope, scoped, computed } from "../packages/core/lib";
import { f, staticModel } from "../packages/core/lib/models";
import { collection, stateOfCollection } from "../packages/core/lib/models/collection";
import { instanceInternalOf, modelRuntimeOf } from "../packages/core/lib/models/definition";

// V8 diagnostics only, never used for comparative benchmark results.
// Run the bundled file with Node --allow-natives-syntax.
const hasFastProperties = new Function("value", "return %HasFastProperties(value)");
const app = scope();
const Row = staticModel({
  data: { count: f.number(0) },
  setup(self) {
    return { doubled: computed(() => self.count.value * 2) };
  },
});
const source = scoped(app, () => collection(Row));
const registry = stateOfCollection(source);
const row = scoped(app, () => Row.create({ id: "row" }));
const internal = instanceInternalOf(row)!;
console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries({
        definition: modelRuntimeOf(Row),
        registry,
        collection: source,
        internal,
        scope: internal.scope,
        epoch: registry.epoch,
      }).map(([name, value]) => [
        name,
        { fast: hasFastProperties(value), keys: Object.keys(value!) },
      ]),
    ),
    null,
    2,
  ),
);

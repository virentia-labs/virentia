# @virentia/core

Core package for Virentia state models.

Use it to describe business state without depending on React, routing, or any other UI layer. A model is built from small primitives:

- stores remember values;
- events name facts or domain intents;
- effects run external async work;
- reactions describe rules between stores, events, and effects;
- scopes hold concrete values for one app, request, test, widget, or cached screen;
- static models share unit declarations and give each instance isolated state and cleanup;
- owners provide lower-level cleanup boundaries for subscriptions and adapters.

## Links

- Documentation: [movpushmov.dev/virentia/core](https://movpushmov.dev/virentia/core/)

## Install

```sh
pnpm add @virentia/core
```

## Counter

```ts
import { event, reaction, scope, scoped } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";

const Counter = staticModel({
  data: { count: f.number(0) },
  setup(self) {
    const incremented = event<number>();
    reaction({
      on: incremented,
      run(amount) {
        self.count.value += amount;
      },
    });
    return { incremented };
  },
});

const appScope = scope();
const model = scoped(appScope, () => Counter.create({}));

// Instance members carry their own scope, including when called outside `scoped`.
await model.incremented(1);

console.log(model.count.value);
await model.dispose();
```

## Runtime Cleanup

Declare units in `staticModel.setup`, which runs once per definition. Create external resources in `onCreate`, which runs once per instance, and register their cleanup with `self.onCleanup`.

```ts
import { event, reaction, scope, scoped } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";

const Draft = staticModel({
  data: { text: f.string("") },
  setup(self) {
    const changed = event<string>();
    reaction({
      on: changed,
      run(value) {
        self.text.value = value;
      },
    });
    return { changed };
  },
  onCreate(self) {
    const timer = setInterval(() => {}, 1000);
    self.onCleanup(() => clearInterval(timer));
  },
});

const draft = scoped(scope(), () => Draft.create({}));
await draft.changed("saved");
await draft.dispose();
```

Disposal releases that instance's resources and pending effects. Other instances keep running. A new instance can reuse the disposed instance's ID with fresh state.

For a module-style graph with nested unit APIs, `Draft.static()` creates independent native units with values isolated by application scope. Use and dispose that singleton inside `scoped(appScope, ...)`. `.create()` binds direct members and the native APIs of cooperating packages (Forms, net and router). Arbitrary application objects keep their existing behavior.

`owner`, `onCleanup` and `withOwner` remain available for lower-level resource groups and existing factory APIs. They do not need to become model identities.

## Source-stable SIDs

For server/client state transfer, the optional compiler gives imported `store`, `reactive`, `readonlyReactive` and `event` declarations source-stable SIDs. In a Vite application that uses Core with React, Vue or another JSX runtime:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import virentiaCore from "@virentia/core/compiler/vite";

export default defineConfig({
  plugins: [virentiaCore({ namespace: "my-app" })],
});
```

The adapter runs before Vite's regular transforms. Under Vite 8 it parses with Vite's own oxc parser and inserts SIDs into the source as it is; with an older Vite it runs Babel 7, which then must be installed. Both give the same SIDs. It leaves JSX and TypeScript syntax for the rest of the build pipeline. It recognizes named, aliased and namespace imports from `@virentia/core` or `@virentia/ui`, rather than unrelated functions with the same names. The generated SID uses `namespace`, the module path relative to Vite's resolved root, and the source call position. Keep the same relative source paths and namespace on both sides; override `root` when Vite's resolved root is not the intended source root. Use `sid: false` to disable automatic SIDs.

Other build tools can run the Babel 7 plugin exported by `@virentia/core/compiler`, passing a filename and options such as `[[virentiaCore, { root: projectRoot, namespace: "my-app" }]]` in their Babel plugin list. The [`@virentia/ui/vite`](../ui/README.md#ordinary-jsx-compiled-bindings) adapter already includes this Core pass while compiling native Virentia JSX.

The compiler preserves an explicit `sid` in a literal metadata object. For a store without the compiler, pass `store(initial, skipToken, { sid: "session/user" })`; events accept `event({ sid: "session/changed" })`. Automatic SIDs identify declarations across server and client builds of the same source, but change when the source position changes. Native UI prefixes local SIDs per component instance; outside it, repeated factory calls in one scope need distinct explicit SIDs. Snapshots serialize materialized writable SID stores; event SIDs identify events but do not add event state to snapshots.

## Main API

`scope`, `scoped`, `store`, `computed`, `event`, `effect`, `reaction`, `owner`, `onCleanup`, `getOwner`, `withOwner`, `lazyModel`.

`@virentia/core/models`: `staticModel`, `model`, `trait`, `f`, `refs`, `children`, `inverse`, `union`.

Derived effects come from `effect(...).variant(...)`: a variant is a separately
observable front door to the same effect — its own `pending`, `doneData`, and
`abort`, optionally its own params via a mapping function — and calling it drives
the base effect's full lifecycle, so the base's `pending`/`done`/`fail` account
for every call made through any of its variants.

Low-level kernel building blocks for authoring custom units/stores live in `@virentia/core/internal`: `node`, `run`, `context`, `withContexts`, plus tracking, scope, and transaction primitives.

## License

MIT © 2026 movpushmov

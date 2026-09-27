# @virentia/core

Core package for Virentia state models.

Use it to describe business state without depending on React, routing, or any other UI layer. A model is built from small primitives:

- stores remember values;
- events name facts or domain intents;
- effects run external async work;
- reactions describe rules between stores, events, and effects;
- scopes hold concrete values for one app, request, test, widget, or cached screen;
- owners define cleanup boundaries for runtime models.

## Links

- Documentation: [movpushmov.dev/virentia/core](https://movpushmov.dev/virentia/core/)

## Install

```sh
pnpm add @virentia/core
```

## Counter

```ts
import { event, reaction, scope, scoped, store } from "@virentia/core";

export function createCounterModel() {
  const incremented = event<number>();
  const count = store(0);

  reaction({
    on: incremented,
    run(amount) {
      count.value += amount;
    },
  });

  return { count, incremented };
}

const model = createCounterModel();
const appScope = scope();

// `scoped` runs the callback in the scope and its promise waits for everything
// the callback triggers (reactions, effects) to settle.
await scoped(appScope, () => model.incremented(1));

scoped(appScope, () => {
  console.log(model.count.value);
});
```

## Runtime Cleanup

`owner` groups reactions, subscriptions, and cleanup callbacks created at runtime. The returned model root gets `dispose()` and `[Symbol.dispose]()` when it is an object.

```ts
import { event, onCleanup, owner, reaction, store } from "@virentia/core";

export function createDraftModel() {
  return owner(() => {
    const changed = event<string>();
    const text = store("");
    const timer = setInterval(() => {}, 1000);

    reaction({
      on: changed,
      run(value) {
        text.value = value;
      },
    });

    onCleanup(() => {
      clearInterval(timer);
    });

    return { changed, text };
  });
}

const draft = createDraftModel();

draft.dispose();
```

`using` can be used in runtimes or build pipelines that support Explicit Resource Management. Plain `model.dispose()` is the safe baseline.

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

The adapter needs Babel 7 in the build and runs before Vite's regular transforms. It leaves JSX and TypeScript syntax for the rest of the build pipeline. It recognizes named, aliased and namespace imports from `@virentia/core` or `@virentia/ui`, rather than unrelated functions with the same names. The generated SID uses `namespace`, the module path relative to Vite's resolved root, and the source call position. Keep the same relative source paths and namespace on both sides; override `root` when Vite's resolved root is not the intended source root. Use `sid: false` to disable automatic SIDs.

Other build tools can run the Babel 7 plugin exported by `@virentia/core/compiler`, passing a filename and options such as `[[virentiaCore, { root: projectRoot, namespace: "my-app" }]]` in their Babel plugin list. The [`@virentia/ui/vite`](../ui/README.md#ordinary-jsx-compiled-bindings) adapter already includes this Core pass while compiling native Virentia JSX.

The compiler preserves an explicit `sid` in a literal metadata object. For a store without the compiler, pass `store(initial, skipToken, { sid: "session/user" })`; events accept `event({ sid: "session/changed" })`. Automatic SIDs identify declarations across server and client builds of the same source, but change when the source position changes. Native UI prefixes local SIDs per component instance; outside it, repeated factory calls in one scope need distinct explicit SIDs. Snapshots serialize materialized writable SID stores; event SIDs identify events but do not add event state to snapshots.

## Main API

`scope`, `scoped`, `store`, `computed`, `event`, `effect`, `reaction`, `owner`, `onCleanup`, `getOwner`, `withOwner`, `lazyModel`.

Derived effects come from `effect(...).variant(...)`: a variant is a separately
observable front door to the same effect — its own `pending`, `doneData`, and
`abort`, optionally its own params via a mapping function — and calling it drives
the base effect's full lifecycle, so the base's `pending`/`done`/`fail` account
for every call made through any of its variants.

Low-level kernel building blocks for authoring custom units/stores live in `@virentia/core/internal`: `node`, `run`, `context`, `withContexts`, plus tracking, scope, and transaction primitives.

## License

MIT © 2026 movpushmov

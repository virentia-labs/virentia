# @virentia/ui

Virentia UI connects native Core models directly to DOM. A component is a model definition and a view, not a function that reruns whenever state changes. Store bindings change existing text and properties. Conditional fragments replace their own DOM range. There is no virtual tree reconciliation or reactivity compiler.

The package is experimental. Its API is being developed together with Core.

```sh
npm install @virentia/ui@0.1.0 @virentia/core@0.12.0 @sinclair/typebox@0.34.52
```

The [installation guide](https://movpushmov.dev/virentia/ui/installation) shows how to set up Vite and mount your first component.

## One model, one active display

`component({ model, view })` accepts both `model` and `staticModel`. Its `.model` is the original definition. Create controlled instances before rendering and pass them through the `model` prop.

```tsx
import { f, staticModel } from "@virentia/core/models";
import { action, component, render, scope, scoped } from "@virentia/ui";

const CounterModel = staticModel({
  name: "Counter",
  data: { count: f.number(0) },
  setup(self) {
    return { increment: action(() => { self.count.value++; }) };
  },
});

const Counter = component({
  model: CounterModel,
  view: (_props, self) =>
    <button onClick={self.model.increment}>{self.model.count}</button>,
});

const appScope = scope();
const counter = scoped(appScope, () => Counter.model.create({ id: "counter", count: 2 }));
const unmount = render(() => <Counter model={counter} />, document.getElementById("app")!, {
  scope: appScope,
});
```

The view runs once for this attachment. Clicking writes to the native model and changes the same text node. Unmounting this display leaves the supplied model alive; its creator decides when to dispose it. One instance cannot have two simultaneous displays.

Without `model`, UI creates a native instance. Such instances are destroyed on unmount by default. `keep: true` in the component config, or an instance prop override, retains the model for reuse in the same scope. It never retains DOM or refs. Each creation has an ID: explicit `id`, model-config `id(props)`, or a fresh generated string. Automatic IDs are not tree-position identities. Reuse a retained instance or an explicit ID when you need to reopen the same model.

View's typed second argument has `self.model`, `self.id`, `self.scope` and a snapshot array `self.instances`. There is no imported ambient UI `self` and no `use*` API.

## Root models own children

A root model creates controlled children through Core's `children.one` and `children.many`. Rendering passes those instances deeper into the tree.

```tsx
const BoardModel = staticModel({ data: { counters: children.many(CounterModel) } });
const Board = component({
  model: BoardModel,
  view: (_props, self) => <For each={self.model.counters} view={Counter} />,
});
```

Import `children` from `@virentia/core/models` and `For` from `@virentia/ui`. `For` supplies each row's `model` prop automatically. Removing an owned child disposes it; disposing its parent cascades. Uncontrolled child components are also owned by their parent model, with explicit local IDs qualified by parent identity.

Model collections, queries and many-relations publish edits. Insertion, removal and movement change exactly the affected row ranges; they do not match old and new lists. Mutable arrays from `@virentia/mutable` support operation-driven rendering for ordinary data. An ordinary computed array, or wholesale array replacement, recreates all rows and warns in development. Model instances belong in native model containers.

## Bind values; isolate structural decisions

Pass units directly: `{count}`, `class={className}`, `value={text}`. Declare derived units in the model. A plain `.value` read inside the one-time view is a snapshot.

Use a named fragment when an ordinary `if` or ternary must choose structure:

```tsx
view: (_props, self) => {
  function editor() {
    if (!self.model.open.value) return null;
    return <Editor model={self.model.editor.value!} />;
  }
  return <main><h1>{self.model.title}</h1>{editor}</main>;
}
```

Only `editor` subscribes to `open`. A structural change removes its old range and constructs the chosen branch anew, even if the tags happen to match. The heading's DOM stays in place. Put draft state in the model, not an uncontrolled DOM node inside a replaceable fragment.

Plain prop values are snapshots; explicit input units remain reactive. Their sources can be retargeted without rerunning view. DOM input writes are explicit event/action work, not two-way bindings.

The same rendering works in ordinary JavaScript: replace JSX with `h("button", { onClick: self.model.increment }, self.model.count)`. Standard JSX transformation is only syntax. The optional `@virentia/core/compiler` and `@virentia/core/compiler/vite` entrypoints instrument stable SID metadata; they do not rewrite expressions or async functions.

`@virentia/ui/vite` also compiles JSX subtrees of native elements into templates: their static DOM is built once and cloned, and only expressions, components and handlers are bound at mount. Expressions stay where they are written and run in the same order; the DOM, component paths, server output and a description's `type`/`props` are those of plain JSX. Pass `templates: false` to keep the JSX runtime's calls, for example to compare.

## Refs and lifecycle are Core units

Declare `ref<Element>()`, or a writable `store<Element | null>(null)`, in the model. Add `with: [ui]` to get native `self.mounted` and `self.unmounted` event units.

```ts
setup(self) {
  const input = ref<HTMLInputElement>();
  reaction({ on: self.mounted, run: () => input.value?.focus() });
  return { input };
}
```

Bind the returned store as `<input ref={self.model.input} />`. Refs are populated before mounted reactions, with the complete DOM connected. Unmount is asynchronous: it waits for unmounted reactions, then removes DOM and clears refs. `await unmount()` and `await instance.dispose()` wait for that phase. Scalar updates remain active during it, allowing exit animations.

`action(run)` combines an event and a reaction owned by the model. DOM handlers accept event/action units, not inline callbacks. Actions work before DOM exists and while a retained model has no display.

Direct `await` of a Virentia unit preserves its caller's scope and model context. Arbitrary native promises, including `await fetch()`, do not have that guarantee. Keep a concrete instance handle or re-enter an explicit scope after such an await.

## Scopes, SSR and tests

`render`, `hydrate` and server rendering require an explicit scope. Several roots may share one scope and unmount independently. A ready model from another scope is rejected before root DOM changes.

Native SSR renders HTML with hydration boundaries. After rendering, `serialize(scope)` captures materialized writable SID stores, including `staticModel` fields under each instance's identity namespace, and a model identity manifest. Snapshots are JSON-only; DOM refs, computed caches and runtime registries are excluded.

Create a separate client `scope({ snapshot })`, recreate application-owned roots and their owned children from `instance.json()` DTOs through the same model declarations, then hydrate the existing DOM. A snapshot restores matching field values but does not create the model tree. Server and client need the same IDs, child order, stable model names/SIDs and root `identifierPrefix`. Give application-owned roots explicit stable IDs; generated `~tmp` IDs are not a cross-request identity contract. UI-created models must reconstruct the same identities with the same prefix. The nested array/shape hydration test in `ecosystem/tests` exercises it end to end.

Use ordinary Vitest `test` and `test.concurrent` with a DOM environment. Create a scope in the test or in your own Vitest fixture, then pass it to `render`/`hydrate`. Shared static definitions and equal model IDs remain isolated by scope, without resetting global state. Virentia does not create test scopes, import Vitest, or replace its test API. Await the returned unmount function when you need to verify teardown.

`@virentia/ui/start` supplies a one-page load/SSR/hydration convention and a Node deployment build. There is no router.

## Embedded mode and current limits

`asReact` from `@virentia/ui/react` and `asVue` from `@virentia/ui/vue` embed a native component in the host app. Virentia owns DOM updates; host commits supply props. No extra wrapper element is inserted.

Adapters currently require one declared stable intrinsic root, e.g. `component({ model, view, root: "button" })`. They infer scope from a ready model or use the host's Core provider. Host SSR currently emits an empty root and mounts native contents on client commit; native content SSR inside React/Vue is not implemented. Host renderers cannot await physical host removal, so standalone's connected-DOM guarantee during async unmounted does not extend to host-owned unmounts.

Union/inverse containers without an operation feed currently use full list replacement with a development warning. Use direct model collections/queries and owned/ref many-relations for guaranteed operation-driven updates.

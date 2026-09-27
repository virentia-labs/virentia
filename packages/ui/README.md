# @virentia/ui

Experimental UI runtime for Virentia. Every function component has a Core `staticModel` definition and a model instance with an ID. Component setup runs once per mounted instance; stores update text, attributes and DOM properties through fine-grained bindings. There is no component render loop or virtual DOM reconciliation.

This is the first implementation milestone toward a complete UI framework, not React API compatibility. The package is private while the API is being developed.

## Try the playground

From the repository root:

```sh
pnpm install
pnpm --filter @virentia/ui dev
```

The TSX playground includes a counter, a derived value, keyed editable rows and a conditional branch. It displays setup/cleanup counts. Reverse the list after typing into a row: the same input moves with its key.

```sh
pnpm --filter @virentia/ui test
pnpm --filter @virentia/ui typecheck
pnpm --filter @virentia/ui build
pnpm --filter @virentia/ui playground:build
```

## Ordinary JSX, compiled bindings

```tsx
import { action, computed, render, store } from "@virentia/ui";

function Counter() {
  const count = store(0);
  const doubled = computed(() => count.value * 2);
  const increment = action(() => {
    count.value++;
  });

  return (
    <button title={`Double: ${doubled.value}`} onClick={increment}>
      Count: {count.value}
    </button>
  );
}

const dispose = render(() => <Counter />, document.getElementById("app")!);
// dispose() removes this root's DOM, listeners and subscriptions.
```

`Counter` runs once for this mount. The compiler does not find dependencies or make arbitrary JavaScript reactive. It turns JSX reads into functions that can run later. For example, `<div title={count.value}>{count.value}</div>` becomes, approximately:

```ts
createElement("div", { get title() { return count.value; } }, () => count.value);
```

At mount time, the runtime evaluates each deferred read inside a Core `reaction`. Core tracks whichever reactive values that read actually uses. When one changes, the relevant binding reads again and patches the existing DOM: text stays the same Text node; an attribute or form-control property is updated in place. `Counter` itself does not run again. Currently an element's props share one binding, while a dynamic child has its own binding. DOM handlers run in the root's captured scope.

Configure Vite:

```ts
import { defineConfig } from "vite";
import virentiaUI from "@virentia/ui/vite";

export default defineConfig({ plugins: [virentiaUI()] });
```

Install Babel 7 alongside the Vite adapter. The runtime does not import Babel or React. It uses `@virentia/core/models` for component instances, so `@sinclair/typebox` is a direct dependency of `@virentia/ui`. The UI adapter also runs Core's SID compiler for recognized `store`, `reactive`, `readonlyReactive` and `event` calls. Other build tools can use the default Babel plugin exported by `@virentia/ui/compiler`; it must run before any other JSX transform. TypeScript stripping remains the build tool's responsibility. For applications that use Core with a different JSX framework, use [`@virentia/core/compiler/vite`](../core/README.md#source-stable-sids) instead.

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@virentia/ui"
  }
}
```

`jsxImportSource` provides JSX types and the automatic runtime. **It does not make eager JSX expressions reactive by itself**: use the compiler for ordinary expressions, or explicit functions when calling `createElement` manually.

## Component identity and retention

Every function component, including an ordinary function used directly in JSX, is backed by a Core `staticModel`. Each mounted instance has a string ID. The runtime chooses it in this order: the component's `props.id`, an `id(props)` selector configured with `component()`, then a tree-derived fallback. Use an explicit ID when an instance must survive removal and later reappearance at a different tree position. IDs must distinguish simultaneously mounted instances of the same component in one application scope; a DOM element's `id` remains an ordinary HTML attribute.

```tsx
import { component, store } from "@virentia/ui";

const Editor = component(
  function Editor(props: { id: string }) {
    const draft = store("");
    return (
      <input
        data-editor={props.id}
        value={draft.value}
        onInput={(event) => {
          draft.value = event.currentTarget.value;
        }}
      />
    );
  },
  { keep: true },
);

<Editor id="profile-editor" />;
```

`keep` is opt-in and defaults to `false`. Without it, unmount disposes the model instance; mounting again creates a new instance and runs component setup again. With `keep: true`, an unmounted instance and its setup are cached by component type and ID in the application scope; the same ID reuses them on remount. Its `mounted` and `unmounted` events fire for every DOM activation. `component(view, { keep: true, id: (props) => props.documentId })` derives an ID from other props. A `props.id` value takes precedence over that selector.

Retention is **model/setup retention, not DOM retention**. Unmount removes DOM nodes, refs, native event listeners and DOM bindings; remount builds and binds DOM again. Model-owned reactions registered during setup survive only if the model is kept. An uncontrolled input's browser-only draft therefore does not survive removal. Keep a draft in reactive state when it must survive. Stores declared during component setup are released from the application scope on final model disposal; stores declared outside setup keep their normal Core lifetime. Core snapshots serialize materialized SID stores, not model fields. To evict a retained instance explicitly, call `collection(Editor.model, appScope).remove("profile-editor")` from `@virentia/core/models`.

## State and props

`store`, `reactive`, `computed`, `event`, `effect`, `reaction`, `scope` and `scoped` are the existing Core APIs. There is no second signal graph. `action(run)` creates a component-owned, scope-bound Core event with a reaction attached to it; the callable result works directly as a JSX event handler. Use `reaction({ scope: useScope(), run })` for other reactive side effects. The second component argument exposes instance-bound views of Core `mounted` and `unmounted` events. Their underlying event nodes are declared once in the generated `staticModel.setup`, not allocated per instance or mount. Declare `reaction({ on: mounted, run })` and `reaction({ on: unmounted, run })` once during component setup; each reaction is routed only to that instance without a manual ID or scope filter. The events fire on each DOM activation, including remounts of a kept model. DOM access belongs in the `mounted` reaction, after insertion, not in setup itself.

For example, focus an input after mounting and release a browser listener on unmount:

```tsx
import { reaction, useId, type ComponentLifecycle } from "@virentia/ui";

function SearchField(
  _props: {},
  { mounted, unmounted }: ComponentLifecycle<{}>,
) {
  const id = useId();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") document.getElementById(id)?.blur();
  };

  reaction({
    on: mounted,
    run() {
      document.getElementById(id)?.focus();
      window.addEventListener("keydown", onKeyDown);
    },
  });
  reaction({
    on: unmounted,
    run() {
      window.removeEventListener("keydown", onKeyDown);
    },
  });

  return <input id={id} />;
}
```

Core owns these reactions through the component model lifetime; with `keep: true`, they remain registered for the next mount. Plain inline DOM callbacks remain available; use `action` when the interaction should participate in the Core event graph.

Pass an existing application scope with `render(() => <App />, container, { scope: appScope })`. Otherwise rendering uses the ambient scope, or creates a new isolated one. `useScope()` returns the mounted scope. Async work should capture that scope and explicitly use `scoped(appScope, ...)` when continuing after an external `await`.

Props stay live through getters, including JSX spreads:

```tsx
function Greeting(props: { name: string }) {
  return <span>Hello, {props.name}</span>;
}

<Greeting name={user.value.name} />;
```

Component setup is ordinary one-time JavaScript. Destructuring `const { name } = props`, destructured component parameters, or assigning `const doubled = count.value * 2` produces a snapshot. Read `props.name` inside JSX, and use `computed` for derived state outside JSX. The compiler does not rewrite arbitrary JavaScript into reactive code.

## Branches and lists

JSX conditional branches preserve the selected branch until its condition changes truthiness:

```tsx
{
  visible.value ? <Editor /> : <p>Hidden</p>;
}
{
  visible.value && <Editor />;
}
```

`Show` exposes the same branch lifecycle explicitly. Unmounting a branch stops its bindings and runs its cleanups; a component configured with `keep: true` retains its model/setup for a later mount with the same ID. Structural mounts can execute new components; updates to already mounted components do not execute them again.

For a truly constant list, ordinary `.map()` is enough; nothing can reorder or replace its rows, so it needs no keys:

```tsx
const links = [{ href: "/", label: "Home" }, { href: "/about", label: "About" }];
const nav = <nav>{links.map((link) => <a href={link.href}>{link.label}</a>)}</nav>;
```

For reactive application data, use Core model instances. `For` can read a `staticModel` definition directly from the current application scope; it follows collection membership and uses each model's ID as the row identity, with no `by` callback:

```tsx
import { f, staticModel } from "@virentia/core/models";
import { For } from "@virentia/ui";

const Todo = staticModel({ data: { title: f.string() } });

function TodoList() {
  return (
    <ul>
      <For each={Todo} fallback={<li>No todos</li>}>
        {(todo, index) => <li>{index() + 1}. {todo().title.value}</li>}
      </For>
    </ul>
  );
}
```

Populate and update `collection(Todo, appScope)` with explicitly identified models; `For` also accepts a collection or sorted query directly. Its row receives live item/index accessors, so a reorder moves the existing DOM without rerunning row setup. For an ordinary reactive array of plain objects, pass `by` when replacement or reorder should preserve row identity:

```tsx
import { For } from "@virentia/ui";

<For each={tasks.value} by={(task) => task.id} fallback={<p>No tasks</p>}>
  {(task, index) => (
    <li>
      {index() + 1}. {task().title}
      <input placeholder="This draft survives reorder" />
    </li>
  )}
</For>;
```

`by` must produce unique keys. Without it, model instances use their IDs; other items use their own identity. An immutable update to a reactive array still changes its membership or order, so row identity matters even though individual item objects are never mutated. Plain `.map()` inside a *reactive* JSX expression rebuilds that expression's subtree and is not a substitute for `For` when rows have state to retain. Item/index bookkeeping is owned by the row and does not accumulate entries in the application scope.

## Context and portals

```tsx
const Theme = createContext("light");

function Label() {
  const theme = useContext(Theme); // a reactive accessor
  return <span class={theme()}>Label</span>;
}

<Theme.Provider value={theme.value}>
  <Label />
</Theme.Provider>;
<Portal mount={document.body}>
  <Dialog />
</Portal>;
```

Context follows the component tree through delayed branches and portals. `useContext` returns an accessor so a provider change does not require rerunning consumers. Portals are removed with their owning component.

## Current boundary

Implemented: DOM mounting, compiled JSX/TSX, native events, controlled input properties, HTML/SVG, styles/classes, refs, scoped bindings, keyed lists, conditional branches, lifecycle, context, client portals, SSR, in-place hydration, a one-page Start template, React/Vue SSR and hydration, ESM/CJS builds and native JSX types. Numeric style values are serialized as given; dimensional values need units, e.g. `width: '12px'`.

Not implemented yet: streaming, native async components, native Suspense/resources, error boundaries, routing, transitions, React hook compatibility, automatic reactive props destructuring, compiler static-template optimizations and component-preserving HMR. The playground uses module-level HMR disposal. Core scope storage retains the normal Core semantics; shared application state outlives component subscriptions.

The next milestones are described in [the architecture note](../../docs/design/ui.md).

## Server rendering and hydration

Use the same compiled components on both sides. Every request gets a fresh scope; load request data before rendering. `renderToString` is synchronous and does not require a DOM implementation. `renderToStringAsync` also awaits foreign renderers such as Vue before returning HTML; native components remain synchronous.

```tsx
// Server
import { scope, serialize } from "@virentia/core";
import { renderToString, serializeState } from "@virentia/ui/server";

const requestScope = scope();
const html = renderToString(() => <App />, {
  scope: requestScope,
  identifierPrefix: "app",
});
const state = serializeState(serialize(requestScope));
// Insert html into the root and state as the contents of an application/json
// script element. serializeState escapes '<' and Unicode line separators.
```

```tsx
// Client — restore state before any component or computed reads it.
import { scope } from "@virentia/core";
import { hydrate } from "@virentia/ui";

const clientScope = scope({
  snapshot: JSON.parse(document.getElementById("app-state")!.textContent!),
});
const dispose = hydrate(() => <App />, document.getElementById("app")!, {
  scope: clientScope,
  identifierPrefix: "app",
});
```

Hydration claims the server's elements and text nodes, installs scoped bindings/listeners, then runs mount callbacks. It does not replace the root. `For` retains the claimed rows on subsequent reorder. Uncontrolled input drafts survive hydration. A structural/text mismatch throws an actionable error and disposes partial subscriptions/listeners; it does not silently remount the tree. Keep the emitted HTML comment markers intact and provide valid HTML nesting (for example, an explicit `tbody` inside a table).

For model-backed lists, seed separate server and client scopes with the same model IDs, order and initial field values **before** rendering or hydration. Give every SSR model an explicit stable `id`; Core's generated `~tmp` IDs are local allocation IDs, not a server/client identity contract. Core snapshots currently carry SID stores, not `staticModel` fields or collection membership, so the application must seed model collections from the same data on both sides.

`mounted` and `unmounted` events do not fire during SSR; refs are client-only too. Server DOM owners are disposed after rendering, including failure paths. A `keep: true` component may retain its model and setup reactions in the request scope, so use a fresh scope per request. Components must be synchronous. Server portals and inline script/style children are rejected explicitly. Use external scripts/styles and put DOM-dependent integrations in reactions on `mounted`. `renderToStaticMarkup` omits hydration markers and cannot be hydrated.

`useId()` produces matching DOM IDs for identical server/client trees. Give independent roots unique `identifierPrefix` values and use the same prefix on both sides. These IDs are not list keys.

### Stable store SIDs

The Babel compiler/Vite plugin generates SIDs for binding-verified `store` and `reactive` calls imported from `@virentia/core` or `@virentia/ui`, including `.ts` state modules. A declaration SID encodes a namespace, root-relative source path and call offset; it never uses a machine-specific absolute path or process-global counter. Configure the same `root` and `namespace` for server/client builds:

```ts
virentiaUI({ root: projectRoot, namespace: "my-app" });
```

Within a mounted component, the runtime prefixes the declaration SID with its deterministic instance ID path. Two instances of one component therefore hydrate independent local stores. Give the same explicit component IDs on server and client, or preserve the same tree positions for generated fallback IDs. Module stores retain their declaration SID. Use explicit metadata when building without the compiler:

```ts
const user = store(null, undefined, { sid: "session/user" });
```

Core's `serialize(scope)` includes only materialized writable SID stores, never computed caches, handlers or injected dependencies. `scope({snapshot})` restores values lazily before the first read/write, including stores created during component setup. Explicit `scope({values})` entries override snapshot values. Duplicate SIDs in one scope throw instead of silently merging state.

Snapshots accept strict JSON values: unsupported values, accessors, cycles, `undefined`, non-finite numbers and class instances fail explicitly. Use an application-level codec for such data. Automatic source SIDs are stable between server/client builds of the same source, not persistent schema IDs across code edits. Same-site factory calls outside separate UI instances require explicit unique SIDs/namespaces. Auto-SID instrumentation requires literal metadata objects and non-spread arguments; use `sid: false` to opt out of the compiler pass where necessary.

SSR remains experimental: preload async data with explicit request scopes; concurrent ambient `scoped(async ...)` is not request-local async storage. Core's existing inspector retention also needs hardening before treating this as an unbounded production server.

Run the SSR/hydration demo with `pnpm --filter @virentia/ui ssr:dev`.

## Start: one-page SSR application

`@virentia/ui/start/vite` provides a convention for one server-rendered page at any request path. Its Vite plugin combines Core SID instrumentation, the UI JSX compiler, a development HTML handler, and generated server/client entries. Create these files in the Vite root:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import virentiaStart from "@virentia/ui/start/vite";

export default defineConfig({ plugins: [virentiaStart()] });
```

```tsx
// app.tsx
/** @jsxImportSource @virentia/ui */
import { store } from "@virentia/ui";

export default function App(props: { data: { greeting: string } }) {
  const clicks = store(0);
  return (
    <main>
      <h1>{props.data.greeting}</h1>
      <button onClick={() => clicks.value++}>Clicks: {clicks.value}</button>
    </main>
  );
}
```

```ts
// load.server.ts (optional)
export default function load({ url }: { url: URL }) {
  return { greeting: url.searchParams.get("hello") ?? "Hello" };
}
```

`load.server.ts` runs once per request on the server and may return a promise. It receives `{ url, request }`, where `request` is Node's `IncomingMessage`. The resolved data must be strict JSON data: no cycles, accessors, `undefined`, negative zero, non-finite numbers or class instances. The same data is embedded safely in the page payload and passed as `App`'s `data` prop during server rendering and browser hydration. Without a loader, `data` is `null`. Start awaits foreign SSR renderers before serializing state; native components remain synchronous. An intentionally thrown `Response` from the loader sets the HTTP status, headers and body.

Start creates a fresh Core scope per request, serializes its materialized SID stores, and hydrates the existing DOM with the same `identifierPrefix`. It supplies a document with `virentia-start-root` and `virentia-start-payload` elements and includes the built client CSS and module assets. `app`, `load`, `identifierPrefix`, `title` and `namespace` are configurable in `virentiaStart({ ... })`; the defaults are `app.tsx`, an optional `load.server.ts`, `"app"`, `"Virentia"` and `"app"`. This is a single-page SSR template, not a router: the loader sees the URL and the same App handles every page request.

From this monorepo, run `pnpm --filter @virentia/ui start:dev` for the example. For its production build, run `pnpm --filter @virentia/ui build`, then `pnpm --filter @virentia/ui start:build` and `pnpm --filter @virentia/ui start:serve`. The `virentia-start build|serve` binary and `buildStart`, `createStartServer`, `serveStart` exports from `@virentia/ui/start/node` are available for the same convention in another project. The CLI accepts `--root`; `serve` also accepts `--port` and `--host`. The build writes `dist/client` and `dist/server` under the Vite root; the Node server serves those assets and renders page requests.

For a custom HTTP/document integration, `await renderPageAsync(view, data, { identifierPrefix })` and `hydratePage(view, container, payloadText)` from `@virentia/ui/start` expose the same scope, snapshot and hydration protocol. The async renderer returns `{ html, payload }` after every foreign renderer settles, with `payload` escaped for an `application/json` script element. `renderPage` remains available for synchronous trees. `hydratePage` returns `{ data, scope, dispose }`. `renderDocument` can wrap a rendered page with asset URLs. The lower-level [`renderToString`/`hydrate` flow](#server-rendering-and-hydration) remains available when the application owns those details.

## React and Vue subtrees

`ReactTree` and `VueTree` mount an existing framework's subtree inside a native Virentia component. Keep React-authored TSX in a separate module with `/** @jsxImportSource react */`, or exclude it from the Virentia JSX Vite transform; Vue components can be built through their normal Vue pipeline. The UI Vite adapter supports `include` and `exclude` filters. Construct the foreign node with its own renderer so the UI compiler only handles the outer Virentia JSX:

The `@virentia/react` plus React/React DOM peers are needed for `ReactTree`; `@virentia/vue` plus Vue are needed for `VueTree`. These peers are optional for applications that do not use the corresponding bridge.

```tsx
import { createElement as reactElement } from "react";
import { h as vueH } from "vue";
import { store } from "@virentia/ui";
import { ReactTree } from "@virentia/ui/react";
import { VueTree } from "@virentia/ui/vue";
import { ReactWidget } from "./ReactWidget";
import { VueWidget } from "./VueWidget";

function App() {
  const label = store("Ready");
  return (
    <>
      <ReactTree node={reactElement(ReactWidget, { label: label.value })} />
      <VueTree as="section" node={vueH(VueWidget, { label: label.value })} />
    </>
  );
}
```

Each bridge owns an ordinary non-void HTML host (`div` by default; `as` changes it). The `node` prop stays live, so a Core change can update the React element or Vue VNode without replacing the host. The bridges provide the current Core scope to `@virentia/react` or `@virentia/vue` through their `ScopeProvider`, allowing their `useUnit` hooks to read the same scoped stores. Native UI disposes the foreign root before removing its host.

On Node, package export conditions select the server adapters automatically for the same `@virentia/ui/react` and `@virentia/ui/vue` imports. Other SSR integrations can import `@virentia/ui/react/server` or `@virentia/ui/vue/server` explicitly. Browser entries do not import server renderers. React uses `renderToString`; Vue uses its asynchronous server renderer, including async Vue setup. Use `await renderToStringAsync(...)` for mixed trees, or Start, which already awaits them. `renderToStaticMarkupAsync` omits native hydration metadata.

Virentia claims each marked host after validating the native tree, then React's `hydrateRoot` or Vue's `createSSRApp` adopts the existing children. Both bridges use stable per-host ID prefixes and the shared Core scope. Initial Core reads use a captured hydration scope so another subtree's mount effects cannot change the first hydration render; actions and subscriptions remain bound to the live application scope. Foreign roots and Vue SSR effect scopes are released on disposal, including failure paths.

Set `ssr={false}` for a browser-only widget: the server emits an empty host and its client renderer mounts after native hydration. React server rendering currently uses its synchronous API, so suspended React content follows that API's fallback behavior; this is not a streaming renderer. Server portals and Vue Teleport transport are unsupported. Native Virentia components keep their one-time setup semantics.

`examples/start-mixed` demonstrates native, React and Vue counters sharing one store. After building the packages, run `virentia-start build --root examples/start-mixed` and `virentia-start serve --root examples/start-mixed` from `packages/ui` (or invoke `node dist/start/cli.mjs` directly).

# Effects

An effect is for external work that finishes later: an HTTP request, storage write, worker call, timer, analytics event, or external API call.

```ts
const searchFx = effect(async (text: string, { signal }) => {
  const response = await fetch(`/api/search?q=${text}`, { signal });
  return (await response.json()) as string[];
});
```

An effect is callable, but that is not its main value. Its main value is making the async lifecycle visible to the model.

## What Effects Expose

An effect exposes result events and state stores. `started` receives call params. `done` and `failed` receive params with the result or error. `doneData` and `failData` expose only the result or error. `settled` and `finally` run in both cases. `$pending` tells whether any call is active, and `$inFlight` stores the number of active calls.

Effect lifecycle state is published immediately when async work starts or settles. It is not hidden until the surrounding business transaction commits, because UI often needs `$pending` and `$inFlight` as execution state rather than domain state.

This lifecycle exception is part of the broader [transaction model](/core/transactions).

```ts
searchFx.started;
searchFx.done;
searchFx.doneData;
searchFx.failed;
searchFx.fail;
searchFx.failData;
searchFx.finally;
searchFx.settled;
searchFx.abort;
searchFx.aborted;
searchFx.$pending;
searchFx.$inFlight;
```

The model can react to them like normal events. A search model can keep status, error, results, and cancellation in one place:

```ts
import { effect, event, reaction, store } from "@virentia/core";

const queryChanged = event<string>();
const searchSubmitted = event<void>();
const searchCancelled = event<void>();

const query = store("");
const results = store<string[]>([]);
const errorMessage = store<string | null>(null);
const status = store<"idle" | "loading" | "ready" | "failed" | "cancelled">("idle");

const searchFx = effect<string, string[], Error>(async (text, { signal }) => {
  const response = await fetch(`/api/search?q=${encodeURIComponent(text)}`, { signal });

  if (!response.ok) {
    throw new Error("Search failed");
  }

  return (await response.json()) as string[];
});

reaction({
  on: queryChanged,
  run(text) {
    query.value = text;
  },
});

reaction({
  on: searchSubmitted,
  run() {
    void searchFx(query.value);
  },
});

reaction({
  on: searchFx.started,
  run() {
    status.value = "loading";
    errorMessage.value = null;
  },
});

reaction({
  on: searchFx.doneData,
  run(items) {
    results.value = items;
    status.value = "ready";
  },
});

reaction({
  on: searchFx.failData,
  run(error) {
    if (status.value === "cancelled") return;

    status.value = "failed";
    errorMessage.value = error.message;
  },
});

reaction({
  on: searchFx.aborted,
  run() {
    status.value = "cancelled";
  },
});

reaction({
  on: searchCancelled,
  run() {
    void searchFx.abort(new Error("Search cancelled"));
  },
});

export const searchModel = {
  errorMessage,
  loading: searchFx.$pending,
  query,
  queryChanged,
  requests: searchFx.$inFlight,
  results,
  searchCancelled,
  searchSubmitted,
  status,
};
```

Loading, result, error handling, and cancellation stay in the model instead of spreading through components. UI can read `loading`, `requests`, `status`, `results` and only call `searchSubmitted` or `searchCancelled`.

## Effect variants

Use `effect.variant` when a model needs its own public operation, but the actual work already exists in another effect. This is common for API effects: several models can reuse the same transport handler while keeping separate `$pending`, `doneData`, `failData`, and `aborted` units.

```ts
import { effect, store } from "@virentia/core";

const token = store("");

const requestFx = effect(async (params: { id: number; token: string }, { signal }) => {
  const response = await fetch(`/api/items/${params.id}`, {
    headers: { Authorization: `Bearer ${params.token}` },
    signal,
  });

  return response.json();
});

const authorizedRequestFx = requestFx.variant("authorizedRequestFx", (id: number) => ({
  id,
  token: token.value,
}));
```

When `authorizedRequestFx(42)` runs in a scope, the mapper reads `token` from that scope and passes assembled params to the handler of `requestFx`.

The lifecycle belongs to the variant. Calling `authorizedRequestFx` does not emit `requestFx.doneData` and does not make `requestFx.$pending` true. Scoped handler overrides of the base effect still apply, so tests can replace `requestFx` once and all variants will use that handler.

If the call params already match the base effect, omit the mapper:

```ts
const profileLoadUserFx = requestFx.variant("profileLoadUserFx");
```

`attach` is still available for compatibility with code that prefers `source` and `mapParams`, but new Virentia code should usually use `variant`: stores are regular scoped values, so reading `token.value` is clearer than declaring a separate source list.

## Cancellation

The effect handler receives an `AbortSignal`. Pass it to APIs that support cancellation: `fetch`, adapter functions, worker tasks, or long-running operations.

`searchFx.abort(reason)` cancels active calls of this effect. First, `aborted` runs with `{ params, reason }`; then the call finishes as a failure and goes through `failData` and `settled`. That is why the model above does not let the generic `failData` handler overwrite the `cancelled` status.

If you need to cancel one specific call, pass an external `AbortSignal` when starting it:

```ts
const cancelReason = new Error("Search cancelled");
const controller = new AbortController();

const promise = scoped(appScope, () =>
  searchFx("virentia", {
    signal: controller.signal,
  }),
);

controller.abort(cancelReason);

await promise.catch((error) => {
  if (error !== cancelReason) throw error;
});
```

Temporary models also cancel effect calls created inside them when their owner is disposed.

Prefer effects over plain promise chains when other parts of the model need to know that async work started, finished, failed, or was cancelled.

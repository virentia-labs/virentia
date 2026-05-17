# Эффекты

Эффект нужен для внешней работы, которая завершается позже: HTTP-запрос, запись в storage, worker, таймер, аналитика, обращение к внешнему API.

```ts
const searchFx = effect(async (text: string, { signal }) => {
  const response = await fetch(`/api/search?q=${text}`, { signal });
  return (await response.json()) as string[];
});
```

Эффект можно вызвать как функцию, но его главная польза не в этом. Он делает жизненный цикл асинхронной работы видимым для модели.

## Жизненный цикл эффекта

У эффекта есть события результата и сторы состояния. `started` получает параметры вызова. `done` и `failed` получают параметры вместе с результатом или ошибкой. `doneData` и `failData` дают только результат или ошибку. `settled` и `finally` срабатывают в обоих случаях. `$pending` показывает, есть ли активная работа, а `$inFlight` хранит количество активных вызовов.

Состояние жизненного цикла эффекта публикуется сразу при старте и завершении асинхронной работы. Оно не прячется до коммита окружающей бизнес-транзакции, потому что для UI `$pending` и `$inFlight` чаще являются состоянием исполнения, а не доменным состоянием.

Это исключение жизненного цикла описано подробнее в общей [модели транзакций](/ru/core/transactions).

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

Модель может реагировать на них так же, как на обычные события. Например, поисковая модель может держать статус, ошибку, результаты и отмену в одном месте:

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

Так loading, результат, ошибка и отмена остаются частью модели, а не расползаются по компонентам. UI может читать `loading`, `requests`, `status`, `results` и просто вызывать `searchSubmitted` или `searchCancelled`.

## attach

`attach` нужен, когда параметры эффекта собираются из двух мест: часть приходит вместе с вызовом, а часть уже лежит в сторах модели. Типичный пример — запрос, которому нужен id из события и token из текущего scope.

```ts
import { attach, effect, store } from "@virentia/core";

const token = store("");

const requestFx = effect(async (params: { id: number; token: string }, { signal }) => {
  const response = await fetch(`/api/items/${params.id}`, {
    headers: { Authorization: `Bearer ${params.token}` },
    signal,
  });

  return response.json();
});

const authorizedRequestFx = attach({
  source: token,
  effect: requestFx,
  mapParams: (id: number, token: string) => ({ id, token }),
});
```

Когда `authorizedRequestFx(42)` вызывается в scope, `attach` читает `token` именно из этого scope и передает в обработчик уже собранные params. `source` может быть одним стором, массивом сторов или объектом сторов.

Если передать существующий эффект, `attach` переиспользует его обработчик. Жизненный цикл при этом принадлежит новому эффекту: читать `$pending`, `doneData`, `failData` и `aborted` обычно нужно у `authorizedRequestFx`.

## Отмена

Handler эффекта получает `AbortSignal`. Передавайте его в API, которое умеет отменяться: `fetch`, свои adapter-функции, worker-задачи или долгие операции.

`searchFx.abort(reason)` отменяет активные вызовы этого эффекта. Сначала сработает `aborted` с `{ params, reason }`, а сам вызов завершится ошибкой и пройдет через `failData` и `settled`. Поэтому в модели выше общий обработчик `failData` не перетирает статус `cancelled`.

Если нужно отменить один конкретный вызов, передайте внешний `AbortSignal` при запуске:

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

Временные модели также отменяют созданные внутри вызовы эффекта через `dispose` владельца.

Используйте эффекты вместо обычных promise-цепочек, когда другим частям модели важно знать, что async-работа началась, завершилась, упала или была отменена.

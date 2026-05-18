# @virentia/core API

Используйте `@virentia/core`, чтобы строить модели состояния.

## scope

Создает изолированный контейнер значений.

Используйте scope, когда одна и та же модель должна работать без общего состояния: в браузерном приложении, запросе, тесте, смонтированном виджете или кешированном экране.

```ts
import { scope } from "@virentia/core";

const appScope = scope();
```

Обычно один scope соответствует экземпляру приложения, запросу, тесту, предпросмотру или фоновой модели в кеше.

## scoped

Запускает функцию в scope. Если функция возвращает promise, тот же scope сохраняется для этой promise-цепочки до ее завершения.

```ts
import { store, scoped } from "@virentia/core";

const count = store(0);

scoped(appScope, () => {
  count.value = 1;
});
```

Используйте `scoped`, чтобы читать и писать сторы напрямую.

```ts
await scoped(appScope, async () => {
  const response = await fetch("/api/count");
  count.value = (await response.json()).count;
});
```

`scoped` также может создать runner для повторного запуска и callback-функций.

```ts
const inAppScope = scoped(appScope);

await inAppScope(() => loadFx());

const onMessage = inAppScope.wrap((message: string) => {
  messages.items = [...messages.items, message];
});
```

Если код уже выполняется внутри scope, его можно не передавать.

```ts
scoped(() => {
  count.value += 1;
});
```

## store

Создает записываемый стор, значение которого хранится в scope.

Используйте стор для состояния, которым владеет модель. Одно определение стора может иметь разные значения в разных scopes.

```ts
const count = store(0);
const profile = store({ name: "Ada", age: 36 });

scoped(appScope, () => {
  count.value += 1;
  profile.age = 37;
});
```

Производные сторы:

```ts
const doubled = count.map((value) => value * 2);
const positive = count.filter((value) => value > 0);
const label = count.filterMap((value) => (value > 0 ? `#${value}` : "skip"), "skip");
```

`map`, `filter` и `filterMap` создают ленивые read-only сторы. Без подписки они пересчитываются только при чтении. Если на них подписана реакция или UI, они пересчитываются при изменении зависимостей.

Подписка на обновления в scope:

```ts
const unsubscribe = count.subscribe((value, scope) => {
  console.log(value, scope);
});

unsubscribe();
```

## computed

Создает read-only стор с ленивым вычислением.

```ts
const visibleUsers = computed(() => {
  const text = query.value.toLowerCase();

  return users.items.filter((user) => user.name.toLowerCase().includes(text));
});
```

`computed` запоминает результат отдельно в каждом scope. Зависимости определяются автоматически по сторам, прочитанным внутри функции. Без активных подписок вычисление не запускается после изменения зависимостей, пока значение не прочитают.

## lazyModel

Создает ленивую оболочку модели.

Используйте `lazyModel`, когда модель вынесена в отдельный модуль и должна импортироваться только при запуске или вызове одного из ее юнитов.

```ts
const chat = lazyModel(() =>
  import("./chat.model").then(({ createChatModel }) => createChatModel()),
);

await allSettled(chat.opened, {
  scope: appScope,
  payload: "chat:1",
});
```

Реакции могут подписываться на ленивые события и lifecycle-юниты эффектов до загрузки модуля. Чтение сторов остается синхронным, поэтому читайте сторы ленивой модели после того, как модель уже загрузилась.

## event

Создает вызываемое событие.

Используйте событие, когда модель должна узнать, что что-то произошло. События несут payload и запускают связанные реакции.

```ts
const submitted = event<{ text: string }>();
```

Обрабатывайте событие через реакции:

```ts
reaction({
  on: submitted,
  run({ text }) {
    query.value = text;
  },
});
```

Производные события:

```ts
const textOnly = submitted.map(({ text }) => text);
const nonEmpty = textOnly.filter((text) => text.length > 0);
const normalized = nonEmpty.filterMap((text) => text.trim() || undefined);
```

## effect

Создает вызываемый юнит для работы с внешним миром.

Используйте эффект для асинхронной работы. Эффекты раскрывают события и сторы жизненного цикла, чтобы остальная модель могла реагировать на загрузку, успех, ошибку и отмену.

```ts
const loadUserFx = effect(async (id: string, { signal }) => {
  const response = await fetch(`/api/users/${id}`, { signal });
  return (await response.json()) as { id: string; name: string };
});
```

Юниты эффекта:

```ts
loadUserFx.started;
loadUserFx.done;
loadUserFx.failed;
loadUserFx.fail;
loadUserFx.doneData;
loadUserFx.failData;
loadUserFx.finally;
loadUserFx.settled;
loadUserFx.abort;
loadUserFx.aborted;
```

Сторы эффекта:

```ts
loadUserFx.$pending;
loadUserFx.$inFlight;
```

Вызов внутри scope:

```ts
const user = await scoped(appScope, () => loadUserFx("user:1"));
```

Отмена выполняющихся вызовов:

```ts
await scoped(appScope, () => loadUserFx.abort(new Error("cancelled")));
```

## attach

Создает новый эффект, который перед запуском читает source-сторы и собирает params.

```ts
const authorizedFx = attach({
  source: token,
  effect: requestFx,
  mapParams: (id: number, token: string) => ({ id, token }),
});
```

`source` может быть одним стором, массивом сторов или объектом сторов. Если `effect` — существующий эффект, `attach` переиспользует его обработчик, а жизненный цикл остается у нового эффекта.

## reaction

Создает правило модели.

По умолчанию начинайте с автовычисления зависимостей: передайте функцию, прочитайте внутри нужные сторы, и Virentia сама поймет, от каких значений зависит реакция. Такая реакция пересобирает зависимости при каждом запуске.

Автоматическая реакция:

```ts
reaction(() => {
  fullName.value = `${firstName.value} ${lastName.value}`;
});
```

Это не единственный режим. Если причина запуска сама важна — конкретное событие, эффект или юнит жизненного цикла — используйте явный `on`. В таком варианте payload остается видимым, а реакция запускается только от указанного юнита.

Явный `on`:

```ts
reaction({
  on: submitted,
  run(payload) {
    console.log(payload);
  },
});
```

Несколько источников:

```ts
reaction({
  on: [firstChanged, secondChanged],
  run(payload) {
    console.log(payload);
  },
});
```

Остановить реакцию:

```ts
const subscription = reaction({
  on: submitted,
  run() {},
});

subscription.stop();
```

## allSettled

Запускает юнит или ноду и ждет завершения асинхронной работы в графе.

Используйте `allSettled` на явных границах: в тестах, серверных загрузчиках, командах, адаптерах фреймворков и местах, где передать `scope` понятнее, чем открывать рамку scope.

```ts
await allSettled(submitted, {
  scope: appScope,
  payload: { text: "hello" },
});
```

Полезно в тестах, SSR и helpers для библиотек.

## owner

Создает границу жизненного цикла.

Используйте `owner` для моделей, которые создаются во время работы приложения. Все очистки, зарегистрированные внутри, можно выполнить вместе через `dispose`.

```ts
const model = owner(() => {
  const incremented = event<void>();
  const count = store(0);

  reaction({
    on: incremented,
    run() {
      count.value += 1;
    },
  });

  return { count, incremented };
});

model.dispose();
```

Корневой объект модели также получает `[Symbol.dispose]`, поэтому в средах с поддержкой Explicit Resource Management можно использовать `using`.

```ts
{
  using model = owner(() => {
    return { count: store(0) };
  });
}
```

## onCleanup, getOwner, withOwner

Используйте cleanup-утилиты, когда вспомогательная функция создает таймеры, подписки, browser listeners или другой ресурс, который нужно отвязать вместе с моделью.

```ts
owner((dispose) => {
  const timer = setInterval(() => {}, 1000);

  onCleanup(() => {
    clearInterval(timer);
  });

  return { dispose };
});
```

Подключить очистку к уже известному владельцу. `withOwner(owner, fn)` делает переданного владельца текущим только на время выполнения `fn`:

```ts
const model = owner((dispose, currentOwner) => {
  return { dispose, owner: currentOwner };
});

withOwner(model.owner, () => {
  onCleanup(() => {
    console.log("cleanup");
  });
});
```

Прочитать текущего владельца внутри вспомогательной функции:

```ts
const current = getOwner();
```

## createNode и run

Низкоуровневый API графа для интеграций.

Используйте его только для новых примитивов или адаптеров. В прикладных моделях обычно нужны сторы, события, эффекты и реакции.

```ts
const node = createNode((ctx) => {
  console.log(ctx.value);
});

await run({
  unit: node,
  payload: "hello",
  scope: appScope,
});
```

Внутри ноды `ctx.stop()` останавливает текущую ветку, `ctx.fail(error)` останавливает ее как ошибочную, а `ctx.launch(unit, value)` добавляет другую ноду или юнит в очередь в том же scope и контексте выполнения.

## createContext и withContexts

Передают метаданные через одну цепочку выполнения kernel.

Используйте contexts для данных, которые относятся к одному запуску: request id, tracing, служебные флаги адаптеров. Для состояния приложения используйте сторы.

```ts
const requestId = createContext<string>();

withContexts([requestId.setup("request-1")], () => {
  console.log(requestId.get());
});
```

Внутри ноды:

```ts
const node = createNode((ctx) => {
  console.log(ctx.getContext(requestId));
});
```

# Низкоуровневое ядро

Большая часть кода приложения должна использовать сторы, события, эффекты, реакции и владельцев.

Низкоуровневый kernel нужен интеграциям, которым требуются прямые ноды графа или собственный контекст выполнения.

## createNode и run

```ts
import { createNode, run, scope } from "@virentia/core";

const appScope = scope();

const logNode = createNode((ctx) => {
  console.log(ctx.value);
});

await run({
  unit: logNode,
  payload: "hello",
  scope: appScope,
});
```

Ноды могут передавать значения дальше по графу.

```ts
const second = createNode((ctx) => {
  console.log(ctx.value); // "next"
});

const first = createNode({
  run: () => "next",
  next: [second],
});

await run({ unit: first, scope: appScope });
```

Нода может явно поставить в очередь другую ветку. `ctx.launch` сохраняет текущий scope, contexts, metadata и batch key, но дает ноде выбрать, какой юнит получит следующее значение.

```ts
const gate = createNode((ctx) => {
  ctx.stop();
  ctx.launch(second, "next");
});
```

## Транзакции

Пользовательская модель описана в разделе [Транзакции](/ru/core/transactions). Механика рантайма и причины выбранных решений разобраны во [Внутреннем устройстве](/ru/guide/deep-knowledge).

## Контексты ядра

Контексты ядра передают метаданные выполнения вдоль цепочки `run`.

```ts
const requestId = createContext<string>();

const node = createNode((ctx) => {
  console.log(ctx.getContext(requestId));
});

await run({
  unit: node,
  scope: appScope,
  contexts: [requestId.setup("request-42")],
});
```

Для состояния приложения используйте сторы. Контексты ядра нужны для метаданных, которые относятся к одному запуску.

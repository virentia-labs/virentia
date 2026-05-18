# Совместимость с Effector

`@virentia/effector` нужен, когда модель Virentia должна работать рядом с уже существующим кодом на Effector.

Существующий код на Effector продолжает импортировать `effector`, а модели Virentia используют `@virentia/core`. Этот пакет связывает их scope’ы и передает вызовы между юнитами.

## Установка

```sh
pnpm add @virentia/effector effector @virentia/core
```

## Создание совместимости

Объект совместимости создается один раз и живет вместе с приложением:

```ts
import { createEffectorCompatibility } from "@virentia/effector";

export const effector = createEffectorCompatibility();

effector.link(virentiaSubmitted, effectorSubmitted, ({ id }) => id);
```

Сама изоляция живет не в этом объекте, а в association между scope Virentia и scope Effector:

```ts
import { scope } from "@virentia/core";
import { fork } from "effector";

const association = effector.associate({
  virentia: scope(),
  effector: fork(),
});
```

Юниты Effector при этом остаются одними и теми же объектами. `fork()` создает только изолированное хранилище значений для SSR, тестов и других границ. Когда adapter запускается внутри Effector-графа, `@virentia/effector` берет Effector scope из `stack.scope` и по нему находит связанный scope Virentia.

Нужны оба scope. Если код обращается к совместимости без association, пакет бросит ошибку, а не создаст скрытый scope.

Association не запускает юниты сама и не участвует в исполнении приложения. Она нужна только для регистрации пары scope’ов и последующего `dispose()`. Запускайте код обычными средствами:

```ts
await scoped(virentiaScope, () =>
  allSettled(effectorSubmitted, {
    scope: effectorScope,
    params: "user:1",
  }),
);
```

В этом запуске Virentia scope приходит из `scoped`, а Effector scope — из `allSettled`. Слой совместимости только проверяет, что эти scope’ы уже связаны.

## Операторы Effector

Юниты Virentia можно использовать внутри настоящих операторов Effector:

```ts
import { sample } from "effector";

sample({
  clock: effectorUserClicked,
  source: $session,
  fn: (session, userId) => ({
    userId,
    token: session.token,
  }),
  target: effector.asEffector(virentiaUserOpened),
});
```

Обертка является обычным юнитом Effector. Поддержку target по-прежнему проверяют через `is.targetable`.

## SSR

На каждый request создавайте отдельную association и освобождайте ее после рендера:

```ts
import { allSettled, fork } from "effector";
import { scope, scoped } from "@virentia/core";

const virentiaScope = scope();
const effectorScope = fork();
const association = effector.associate({
  virentia: virentiaScope,
  effector: effectorScope,
});

try {
  await scoped(virentiaScope, () =>
    allSettled(appStarted, {
      scope: effectorScope,
      params: request,
    }),
  );
} finally {
  association.dispose();
}
```

Для scope Virentia используйте snapshot-механизм Virentia, для scope Effector — `serialize` из Effector. Слой совместимости только запоминает связь между ними.

## Откуда берется scope Effector

`@virentia/effector` не пытается достать “текущий scope” из произвольного вызова Effector. Scope появляется только во время исполнения Effector-графа.

Для этого adapter создается как настоящий юнит Effector с child-node на `step.run`. Этот шаг получает `stack`, читает `stack.scope` и ищет заранее созданную association. Если Effector запущен без `fork`, `stack.scope` пустой; в таком режиме изолированный Effector scope получить невозможно.

Когда Virentia-to-Effector adapter запускает Effector-юнит, Effector scope берется из association текущего scope Virentia и используется в `launch({ target, params, scope })`. Если пары нет, это ошибка интеграции.

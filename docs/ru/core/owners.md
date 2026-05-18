# Владельцы и очистка

Владелец (`owner`) нужен модели, которая создается во время выполнения и должна позже отвязать работу, которую создала.

Это часто нужно модальным окнам, чатам, вкладкам документов, медиаплеерам, таймерам и подпискам на браузерные API. Риск не в самом значении стора. Риск в работе вокруг него: реакции, интервалы, внешние слушатели, активные вызовы эффектов и функции очистки.

## Динамическая работа под владельцем

Владелец дает динамической работе один жизненный цикл. Все, что создано внутри `owner`, можно удалить вместе.

```ts
import { event, onCleanup, owner, reaction, store } from "@virentia/core";

export function createDraftModel() {
  return owner(() => {
    const changed = event<string>();
    const text = store("");

    reaction({
      on: changed,
      run(value) {
        text.value = value;
      },
    });

    return { changed, text };
  });
}
```

`owner` добавляет `dispose()` на корневой объект модели. Когда черновик закрывается, вызовите `dispose`. Реакции, созданные внутри владельца, будут отвязаны вместе с ним.

```ts
const draft = createDraftModel();

draft.dispose();
```

Если среда выполнения поддерживает `using` и `Symbol.dispose`, можно доверить очистку блоку кода:

```ts
{
  using draft = createDraftModel();

  // работа с draft
}
```

::: warning

`Symbol.dispose` и `using` еще не одинаково доступны во всех JavaScript runtimes, включая Safari без транспиляции. Если ваш runtime, bundler или транспайлер их не поддерживает, используйте обычный `model.dispose()`.

:::

## Внешняя очистка

Используйте `onCleanup` для работы, о которой Virentia не может знать сама.

```ts
const timerModel = owner(() => {
  const timer = setInterval(() => {}, 1000);

  onCleanup(() => {
    clearInterval(timer);
  });

  return {};
});
```

Используйте `withOwner`, когда вспомогательная функция должна привязать очистку к уже существующему владельцу. Он временно делает этого владельца текущим на время переданной функции, поэтому `onCleanup` внутри нее регистрируется на жизненный цикл модели.

```ts
import { onCleanup, owner, withOwner, type Owner } from "@virentia/core";

const model = owner((dispose, modelOwner) => {
  return { dispose, owner: modelOwner };
});

function connectSocket(modelOwner: Owner) {
  withOwner(modelOwner, () => {
    const socket = new WebSocket("/events");

    onCleanup(() => {
      socket.close();
    });
  });
}

connectSocket(model.owner);
```

Так вспомогательная функция остается переиспользуемой и не отвечает за весь жизненный цикл модели.

Владельцы нужны не только для борьбы с утечками. Они делают решение о жизненном цикле видимым: эта модель временная, эта работа принадлежит ей, а здесь ей разрешено исчезнуть.

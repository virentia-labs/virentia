# Миграция

Не заменяйте импорты `effector` глобально.

Существующий код Effector продолжает использовать настоящий пакет:

```ts
import { createEvent, createStore } from "effector";

export const effectorSubmitted = createEvent<string>();
export const $userId = createStore("").on(effectorSubmitted, (_, id) => id);
```

Новые модели Virentia пишутся отдельно:

```ts
import { event, store } from "@virentia/core";

export const virentiaSubmitted = event<{ id: string }>();
export const userId = store("");
```

После этого части связываются явно:

```ts
import { createEffectorCompatibility } from "@virentia/effector";

export const effector = createEffectorCompatibility();

effector.link(virentiaSubmitted, effectorSubmitted, ({ id }) => id);
```

Association создается там, где известен scope Virentia:

```ts
const association = effector.associate({
  virentia: virentiaScope,
  effector: effectorScope,
});
```

Adapter читает Effector scope из `stack.scope`, когда запускается внутри Effector-графа, и по нему находит scope Virentia. Так приложение можно переносить постепенно. Библиотеки Effector продолжают работать с настоящим Effector, а модели Virentia остаются в своем scope.

## Операторы Effector

Если существующая цепочка Effector должна вызвать юнит Virentia, используйте `effector.asEffector`:

```ts
sample({
  clock: effectorSubmitted,
  target: effector.asEffector(virentiaSubmitted),
});
```

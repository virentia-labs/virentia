# Совместимость с Effector

`@virentia/effector` — compatibility layer поверх ядра Virentia для проектов, где модели уже написаны в стиле Effector.

<div class="compat-status-grid" aria-label="Статус совместимости с Effector">
  <div class="compat-status-card">
    <span class="compat-status-kicker"><span class="compat-status-dot"></span>Runnable upstream</span>
    <strong>100%</strong>
    <span>409 / 409 включённых тестов проходят</span>
  </div>
  <div class="compat-status-card">
    <span class="compat-status-kicker"><span class="compat-status-dot"></span>User-facing coverage</span>
    <strong>97.85%</strong>
    <span>покрытие публичного API</span>
  </div>
  <div class="compat-status-card compat-status-card-muted">
    <span class="compat-status-kicker"><span class="compat-status-dot"></span>Known failures</span>
    <strong>0</strong>
    <span>нет скрытых красных тестов</span>
  </div>
</div>

::: tip Статус совместимости
Сейчас upstream diagnostic показывает `409 passed / 259 skipped / 0 failed / 668 total`.

Более честная метрика для конечного пользователя — `97.85%` user-facing coverage. В неё не входят скипы, которые проверяют внутренний graphite Effector, точные debug stacks, observable interop или eager scheduler snapshots.
:::

## Почему этому можно доверять

| Сигнал                      |           Результат | Что это значит                                                                                |
| --------------------------- | ------------------: | --------------------------------------------------------------------------------------------- |
| 🟢 Runnable upstream tests  | `409 / 409` passing | Все включённые upstream compatibility tests проходят.                                         |
| 🟢 Failed tests             |                 `0` | Нет скрытых известных падений.                                                                |
| 🟢 User-facing coverage     |            `97.85%` | Почти всё важное для прикладного кода покрыто.                                                |
| 🟡 Full upstream diagnostic |            `61.23%` | Остальное в основном внутренности Effector, exact debug/scheduler snapshots и graphite shape. |

## Что покрыто

| Зона                                                                        | Статус     |
| --------------------------------------------------------------------------- | ---------- |
| Events, stores, effects                                                     | ✅         |
| `sample`, `combine`, `guard`, `split`, `merge`, `restore`, `createApi`      | ✅         |
| `fork`, `allSettled`, `serialize`, `hydrate`, основные `scopeBind` сценарии | ✅         |
| Domains, regions, `withRegion`, `clearNode`                                 | ✅         |
| `serialize: "ignore"`, custom serialize read/write, `onlyChanges: true`     | ✅         |
| Runtime/config поведение `skipVoid`                                         | ✅         |
| Точная внутренняя graphite/debug-stack идентичность Effector                | Не обещаем |
| Точный eager intermediate ordering Effector                                 | Не обещаем |

## Оставшиеся важные разрывы

| Разрыв                                   | Количество |
| ---------------------------------------- | ---------: |
| `attach` lifecycle ordering snapshots    |        `5` |
| Async `scopeBind` propagation edge cases |        `3` |
| Nested awaited `allSettled` transaction  |        `1` |

## Замена import

Лучше делать явную замену импортов, а не npm alias:

```diff
-import { createEvent, createStore } from "effector";
+import { createEvent, createStore } from "@virentia/effector";
```

Если проект использует `effector/babel-plugin`, добавьте `@virentia/effector` в тот же import/factory config.

```js
plugins: [
  [
    "effector/babel-plugin",
    {
      importName: ["effector", "@virentia/effector"],
      factories: ["@virentia/effector", "patronum", "farfetched"],
    },
  ],
];
```

## Счётчик

```ts
import { allSettled, createEvent, createStore, fork } from "@virentia/effector";

const incremented = createEvent<number>();
const $count = createStore(0).on(incremented, (count, amount) => count + amount);
const appScope = fork();

await allSettled(incremented, {
  scope: appScope,
  params: 2,
});

console.log(appScope.getState($count)); // 2
```

## Главное отличие

Virentia сохраняет публичную поверхность Effector, но не клонирует внутренний graphite kernel. Слой совместимости ставит наблюдаемое поведение приложения и совместимость с экосистемой выше точного внутреннего устройства Effector.

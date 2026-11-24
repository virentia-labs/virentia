# Локальная проверка экосистемы

Проверяет текущие исходники и собранные пакеты из соседних репозиториев:

```text
virentia/
  virentia/
  forms/
  storage/
  net/
  router/
```

Зависимости и инструменты каждого репозитория должны быть установлены. Core
0.11.2 и локальные адаптеры ещё не опубликованы; `devDependencies` соседних
проектов ссылаются на них через относительные `link:`. Git-команды и установка
пакетов в скрипте проверки не выполняются.

Из каталога библиотеки:

```sh
node scripts/check-ecosystem.mjs
```

Скрипт сначала подключает локальные пакеты и общие React, React DOM, Vue и
Effector через игнорируемые `node_modules`-ссылки. Проверяет, что потребители
разрешают один и тот же каталог Core/адаптеров. Это также исключает ситуацию,
когда Provider, hook или Effector fork принадлежат разным экземплярам библиотеки.
Ссылки остаются для дальнейшей локальной разработки.

Далее последовательно выполняются сборки 19 пакетов, runtime-тесты, проверки
типов и корневых tsconfig, совместные сценарии и ESM/CJS smoke-тесты. У Vitest
один worker; параллельных тестовых процессов нет. Сборки используют текущие
публичные экспорты пакетов. Совместные тесты загружают собранные пакеты.

Выбор отдельного этапа или репозитория:

```sh
node scripts/check-ecosystem.mjs --phase link
node scripts/check-ecosystem.mjs --phase runtime --repo forms
node scripts/check-ecosystem.mjs --phase types --repo router
node scripts/check-ecosystem.mjs --phase integration
node scripts/check-ecosystem.mjs --phase smoke
```

Проверка потребительских бандлов после сборки:

```sh
node scripts/check-bundles.mjs --out /absolute/path/to/bundle-report
```

Она использует Rolldown из установленного tsdown, отключает source aliases и
собирает публичные `dist`-экспорты с production-окружением и минификацией.
Отдельно проверяет удаление неиспользуемых импортов, ESM/CJS `memory` без Core
и запускает девять совместных тестов над собранными бандлами, включая вложенные
array/shape и SSR/hydration. React, Vue и Effector остаются внешними host-пакетами.
`summary.json` сохраняет размеры min/gzip и состав модулей; это проверка веса
кода и семантики, а не runtime-бенчмарк. CLI и CSS сохраняют side effects;
`PURE`-метки не следует удалять при публикации.

Контроль также проверяет, что `event`/`reaction` не удерживают реализацию stores,
а DOM-renderer не импортирует фабрики моделей только для распознавания экземпляра.
Обычные `h`/JSX проверяются отдельно в ESM/CJS без DOM-runtime: сохраняются живые
getters props, ключи и общая идентичность описаний. Инициализация используемых
модулей и удержание их hidden classes при разделении сохраняются.

Для `staticModel` контроль собирает TypeBox внутрь ESM/CJS и проверяет generic
traits, raw schemas, текущие registries и instance policy, изоляцию scopes и
disposal. Неиспользуемый полный namespace builder-функций TypeBox в этих
бандлах считается регрессией; сама валидация и расширения TypeBox сохраняются.

`model-relations.test.ts` дополнительно проверяет children/refs/inverse,
индексированный запрос и `For` через общий исполняемый пример. Он проходит
SSR/hydration с сохранением DOM-узлов, изменение порядка, удаление ссылок,
каскадный disposal, изоляцию scopes и повторное использование ID.

`--phase build` отдельно пересобирает пакеты. `--out /absolute/path` задаёт новый
каталог отчёта; по умолчанию он создаётся в системном временном каталоге.
`summary.json` содержит команды, PID текущего дочернего процесса, результаты
разрешения пакетов и пути логов. Непройденный этап завершает проверку с кодом 1.

Совместные сценарии проверяют маршрут → запрос → форму → хранилище → UI,
изоляцию двух приложений, сериализацию/восстановление, disposal и размонтирование,
а также общие scope-контексты Forms/Net/Router с React и Vue. Открытие маршрута
и завершение пользовательской загрузки проверяются как отдельные этапы:
обработчик browser history не возвращает вызывающему promise загрузки данных.

Составная модель редактора объявлена через `staticModel`. Обычный путь —
`.create()` либо создание через `children`: возвращённые из `setup` native API
Forms, Net и Router сохраняют вложенные stores, методы и lifecycle units
привязанными к экземпляру. Дополнительные aliases вроде `nameValue: form.fields.name.state`
для этого не нужны. Несколько экземпляров в одном приложении и одинаковые ID
в разных приложениях проверяются на полной цепи маршрут → запрос → форма →
storage → DOM, cleanup и повторном создании ID.

Отдельно сохранена совместимость `.static()`: это отдельный модульный граф со
значениями и disposal по application scope. Он нужен при таком владении графом,
а не для сохранения вложенного API. Произвольные пользовательские объекты из
`setup` не получают автоматическую рекурсивную привязку.

Ресурсы persistence подключаются из bound-метода экземпляра, поэтому `onCleanup`
пакета storage получает lifetime этого экземпляра без отдельного `owner()`.

В пользовательском асинхронном коде прямой `await` юнита переносит контекст.
После обычного `fetch`, таймера или стороннего Promise чтения, записи и запуск
следующего юнита нужно выполнять через захваченный `scoped` runner. Валидаторам
форм для чтений после внешнего ожидания доступен привязанный к scope `ctx.read`.

## Что проверяется после миграции

| Пакет | Модельный сценарий |
| --- | --- |
| Forms | scalar `fieldModel`, `arrayFieldModel`, `shapeFieldModel`, custom fieldType, Form, projections и Wizard; `children`/`refs`, reset, DTO membership и snapshot |
| Forms/React | `useField`, `useForm`, `useWizardForm` с привязанными экземплярами |
| Forms/Zod | валидация дочернего поля и зависимости схемы конкретной формы |
| Forms/Effector | зеркала и lenses нескольких экземпляров в одной паре scopes |
| Storage | writable data field/child/ref, hydration и cleanup у вызывающего экземпляра |
| Net | query/mutation, refresh/reset, invalidation, optimistic rollback и отмена |
| Router | route, router, вложенные таблицы маршрутов, trackQuery и lifetime history |
| React/Vue/UI | общий application scope адаптеров, независимые модели и размонтирование |

Бизнес-владение задаётся через `children`/`refs`. Оставшиеся `owner()` в
validation dependency tracker и Effector lenses группируют заменяемые подписки;
они не объявляют граф бизнес-модели и не требуют замены на `staticModel`.

Пример wizard с дочерними полями и `form.pick` находится в
[Forms guide](../../forms/docs/field-models.md). Он проверяется как исполняемый
пример, включая восстановление из DTO и scope snapshot. Собранные ESM/CJS
smoke-тесты также используют wizard с проекцией модельной формы.

Все виды модельных полей показаны в
[Forms all-fields example](../../forms/docs/examples/all-fields.ts). Array/Shape
сами владеют созданными детьми, существующие поля удерживают как refs.
Совместный тест проверяет эти модели с Net, Router, Storage, React, Vue и
Effector; smoke проверяет вложенные поля в собранных ESM/CJS.

`nested-fields-hydration.test.ts` проверяет настоящий SSR → DOM hydration
Virentia UI для array → shape → array: сохранение серверных DOM-узлов, обработку
input, change-валидацию, перемещение/удаление строк, reset и disposal, соседний
экземпляр и повторное использование ID. Сервер и клиент обмениваются JSON DTO и
scope snapshot.

Примеры сайта в `../documentation` отдельно проверяются командой
`pnpm check:packages` из того репозитория после локальной сборки пакетов.
EN/RU используют общие TypeScript snippets; проверка компилирует и исполняет их,
сверяет навигацию, ссылки и anchors разделов Forms/Storage/Net/Router.

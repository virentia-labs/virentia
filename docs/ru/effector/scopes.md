# Скоупы и сериализация

Effector и Virentia хранят состояние в разных scope. `@virentia/effector` хранит явную пару scope’ов:

```ts
const association = effector.associate({
  virentia: virentiaScope,
  effector: effectorScope,
});
```

Объект `effector`, созданный через `createEffectorCompatibility`, остается один. Меняется только association: ее создают на границе жизненного цикла и освобождают через `dispose()`. После `dispose()` связь удаляется из registry и больше не находится через `ensureAssociation`.

## Без неявных scope

Пакет никогда не создает недостающий scope.

```ts
effector.ensureAssociation({ effector: effectorScope });
```

Такой код сработает только если Effector scope уже есть в association. Иначе будет ошибка.

## SSR

Создавайте association на каждый request внутри функции рендера:

```ts
export async function render(request: Request) {
  const virentiaScope = createVirentiaScope(request);
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
    return renderApp(association);
  } finally {
    association.dispose();
  }
}
```

Scope Virentia задается через `scoped`, scope Effector — через `allSettled`, `scopeBind` или Provider в UI. Association заранее связывает эти два scope и удаляется через `dispose()`.

Scope Virentia сериализуется snapshot-механизмом Virentia, scope Effector — через `serialize` из Effector. Слой совместимости хранит только association между ними.

## Поздняя association

Если порядок bootstrap мешает создать association сразу, сделайте это позже:

```ts
effector.associate({
  virentia: virentiaScope,
  effector: effectorScope,
});
```

Effector scope не создается автоматически и не подхватывается позже. Его нужно передать при создании association.

## Scope Effector

Слой совместимости не угадывает Effector scope из глобального состояния. Adapter-юнит читает `stack.scope` в `step.run`. Для SSR и тестов это scope из `fork()`. Для React это тот же scope, который передается в Effector Provider.

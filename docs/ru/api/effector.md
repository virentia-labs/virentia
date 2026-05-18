# API @virentia/effector

`@virentia/effector` связывает юниты Virentia с юнитами настоящего пакета `effector`.

## createEffectorCompatibility

```ts
const effector = createEffectorCompatibility();
```

Создает объект совместимости. Он хранит связи и адаптеры, которые будут подключены к каждой association. Создавайте его один раз на приложение.

## effector.associate

```ts
const association = effector.associate({
  virentia: virentiaScope,
  effector: effectorScope,
});
```

Создает association для пары scope’ов. Когда adapter-юнит запускается внутри Effector-графа, он читает `stack.scope` и ищет уже созданную связь. Когда association больше не нужна, вызовите `association.dispose()`.

## effector.ensureAssociation

```ts
const association = effector.ensureAssociation({ effector: effectorScope });
```

Ищет существующую association. Если связи нет, бросает ошибку.

Association не запускает юниты и не участвует в исполнении приложения. Запускайте Effector через `allSettled`, `scopeBind`, `launch` или UI Provider, а Virentia — через `scoped` и `allSettled` из `@virentia/core`.

## effector.link

```ts
const unlink = effector.link(virentiaEvent, effectorEvent, ({ id }) => id);
```

Устанавливает связь для каждой association, созданной этим объектом совместимости.

## effector.asEffector

```ts
sample({
  clock: effectorEvent,
  target: effector.asEffector(virentiaEvent),
});
```

Возвращает обертку Effector для юнита Virentia. Обертка читает Effector scope из `stack.scope` и по нему находит scope Virentia.

## effector.asVirentia

```ts
reaction({
  on: effector.asVirentia(effectorEvent),
  run(payload) {},
});
```

Возвращает обертку Virentia для юнита Effector.

Если adapter не может найти association по текущему Virentia scope или Effector scope из `stack.scope`, пакет бросит ошибку.

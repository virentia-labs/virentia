# Операторы Effector

Используйте `effector.asEffector`, когда цепочка Effector должна вызвать юнит Virentia.

```ts
sample({
  clock: effectorSubmitted,
  source: $session,
  fn: (session, id) => ({
    id,
    token: session.token,
  }),
  target: effector.asEffector(virentiaSubmitted),
});
```

Возвращенный юнит создан в Effector, поэтому его можно передавать в API Effector.

## Clock

Эту же обертку можно использовать как clock:

```ts
sample({
  clock: effector.asEffector(virentiaSubmitted),
  target: effectorSubmitted,
});
```

События Virentia передаются после завершения текущей транзакции.

## Association

Адаптерам нужна заранее созданная association между scope Virentia и scope Effector:

```ts
const association = effector.associate({
  virentia: virentiaScope,
  effector: effectorScope,
});
```

Effector scope адаптер достает из `stack.scope` во время запуска и использует его для поиска scope Virentia. Если пары нет, адаптер бросит ошибку.

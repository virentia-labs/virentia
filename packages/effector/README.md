# @virentia/effector

Compatibility with the real Effector package.

Use this package when Virentia models need to call Effector units, or existing Effector chains need to call Virentia units. It does not replace Effector.

## Install

```sh
pnpm add @virentia/effector effector @virentia/core
```

## Associate scopes

```ts
import { scope } from "@virentia/core";
import { associate } from "@virentia/effector";
import { fork } from "effector";

const virentiaScope = scope();
const effectorScope = fork();

associate({
  virentia: virentiaScope,
  effector: effectorScope,
});
```

A Virentia scope and an Effector scope are associated globally through weak maps.
The examples below use these associated scopes.

## Universal Ports

Use `fool(unit)` at feature boundaries. The result is a pass-through unit for one direction: one feature writes to the port, another feature reads from it. Effector features can read or write that port as `clock`, `source`, or `target`; Virentia features can read it as `on` or call it from `run`/`scoped`.

The unit keeps the natural call style of the system it came from. A port created from `event()` is called like a Virentia event. A port created from `createEvent()` is launched like an Effector event.

## Virentia Feature To Effector Feature

```ts
import { event, scoped } from "@virentia/core";
import { fool } from "@virentia/effector";
import { createEvent, createStore, sample } from "effector";

const checkoutRequested = fool(event<{ orderId: string }>());

function createVirentiaCheckoutFeature() {
  return {
    requestCheckout: checkoutRequested,
  };
}

function createEffectorBillingFeature() {
  const $session = createStore({ token: "session-token" });
  const billingStarted = createEvent<{ orderId: string; token: string }>();
  const $startedOrders = createStore<string[]>([]).on(billingStarted, (orders, order) => [
    ...orders,
    order.orderId,
  ]);

  sample({
    clock: checkoutRequested,
    source: $session,
    fn: (session, request) => ({
      orderId: request.orderId,
      token: session.token,
    }),
    target: billingStarted,
  });

  return {
    $startedOrders,
    billingStarted,
  };
}

const billing = createEffectorBillingFeature();
const checkout = createVirentiaCheckoutFeature();

await scoped(virentiaScope, async () => {
  await checkout.requestCheckout({ orderId: "order:1" });
});
```

The Virentia feature owns the command and calls it naturally. The Effector feature consumes that one pass-through port as its `clock`, then keeps its own output and state in `billing`.

## Effector Feature To Virentia Feature

```ts
import { event, reaction, store } from "@virentia/core";
import { fool } from "@virentia/effector";
import { allSettled, createEvent, sample } from "effector";

const routeOpened = fool(createEvent<string>());

function createEffectorRoutesFeature() {
  const profileClicked = createEvent<string>();

  sample({
    clock: profileClicked,
    target: routeOpened,
  });

  return {
    profileClicked,
  };
}

function createVirentiaProfileFeature() {
  const profileLoaded = event<{ userId: string; name: string }>();
  const loadedCount = store(0);

  reaction({
    on: routeOpened,
    run(userId) {
      profileLoaded({
        userId,
        name: "Ada",
      });
    },
  });

  reaction({
    on: profileLoaded,
    run() {
      loadedCount.value += 1;
    },
  });

  return {
    loadedCount,
  };
}

const routes = createEffectorRoutesFeature();
createVirentiaProfileFeature();

await allSettled(routes.profileClicked, {
  scope: effectorScope,
  params: "user:1",
});
```

The Effector feature owns navigation and launches its own event naturally. The Virentia feature listens to that universal port with `on`, then calls its own Virentia port from `run`.

Use `scoped`, Effector `allSettled`, `scopeBind`, or UI Providers to choose scopes.

## Tests

```sh
pnpm --filter @virentia/effector test
```

## License

MIT © 2026 movpushmov

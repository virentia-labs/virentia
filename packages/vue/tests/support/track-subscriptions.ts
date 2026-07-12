// A store is a Proxy whose `set` trap rejects writes to `subscribe`, so we can't
// monkeypatch it in place. Instead wrap it in an outer Proxy that intercepts the
// `subscribe` getter to count live subscriptions.
export function trackSubscriptions<T extends object>(unit: T): { unit: T; count: () => number } {
  let active = 0;
  const proxied = new Proxy(unit, {
    get(target, prop, receiver) {
      if (prop === "subscribe") {
        return (fn: any) => {
          active += 1;
          const unsubscribe = (target as { subscribe: (fn: any) => () => void }).subscribe(fn);
          let released = false;
          return () => {
            if (!released) {
              released = true;
              active -= 1;
            }
            return unsubscribe();
          };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { unit: proxied, count: () => active };
}

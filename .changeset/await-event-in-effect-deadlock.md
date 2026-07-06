---
"@virentia/core": patch
---

Fix a deadlock when an effect handler awaits an event after awaiting another effect.

```ts
const fx = effect(async () => {
  await inner();   // await another effect
  await ev("x");   // then await an event — used to hang forever
});
```

When a reentrant drain (the `await inner()` effect) finished asynchronously, it re-installed the parked parent drain as the active drain. The next unit call in the handler's continuation (`await ev()`) then joined that parked drain via `waitForDrain` and never resolved — the drain only settles once the handler finishes, and the handler was blocked on that very call. On asynchronous resume the kernel now restores whatever drain is genuinely active (usually none) instead of the stale parent captured when the drain was created, so the continuation's unit call runs on its own drain and completes.

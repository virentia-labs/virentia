// @virentia/core/utils — standard operator library over units. The inclusion
// bar (docs/design/core-utils.md): an operator earns its place only when it
// needs what neither `computed` nor an imperative reaction body can express —
// time, per-scope memory with the right home, initial values, diagnostics.
// Everything else from the patronum surface is a documentation recipe.

export { debounce, delay, interval, throttle } from "./time";
export type { DebounceOptions, IntervalHandle, IntervalOptions, ThrottleOptions } from "./time";

export { once, previous, reset } from "./algebra";
export type { OnceOptions, ResetOptions } from "./algebra";

export { status } from "./effects";
export type { EffectStatus, StatusOptions } from "./effects";

import * as effector from "effector";

/**
 * effector exports `withFactory` at runtime (it is the hook its babel/SWC
 * plugins compile factory calls into), but leaves it out of the public
 * typings. Re-export it with the signature from effector's region.ts so
 * tests can simulate plugin-instrumented factories.
 */
interface WithFactoryOptions<T> {
  sid: string;
  name?: string;
  loc?: unknown;
  method?: string;
  fn: () => T;
}

export const withFactory = (
  effector as unknown as { withFactory: <T>(options: WithFactoryOptions<T>) => T }
).withFactory;

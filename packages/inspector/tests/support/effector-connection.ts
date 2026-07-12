import { afterEach } from "vitest";
import { connectEffector, type EffectorInspectorConnection } from "../../lib/effector";

/** The raw effector graphite id of a unit — the id the inspector uses for nodes. */
export const graphiteId = (unit: unknown): string =>
  String((unit as { graphite: { id: string } }).graphite.id);

/**
 * Tracks every connection opened through `connect` and disposes them after each
 * test. Call at the top level of a test file so the `afterEach` registers at
 * file scope.
 */
export function createConnectTracker(): {
  connect: (...args: Parameters<typeof connectEffector>) => EffectorInspectorConnection;
} {
  const connections: EffectorInspectorConnection[] = [];

  afterEach(() => {
    while (connections.length) {
      connections.pop()?.dispose();
    }
  });

  const connect = (
    ...args: Parameters<typeof connectEffector>
  ): EffectorInspectorConnection => {
    const connection = connectEffector(...args);
    connections.push(connection);
    return connection;
  };

  return { connect };
}

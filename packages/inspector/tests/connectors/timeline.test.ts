import { describe, expect, it } from "vitest";
import { allSettled, createEffect, createEvent, createStore, fork } from "effector";
import type { DevtoolsTimelineEvent } from "@virentia/core/devtools";
import { createEffectorTimeline } from "../../lib/effector/timeline";

const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createEffectorTimeline", () => {
  it("maps user-facing computations to timeline events and filters operation nodes", async () => {
    const events: DevtoolsTimelineEvent[] = [];
    const timeline = createEffectorTimeline({ onEvent: (event) => events.push(event) });

    const $count = createStore(0, { name: "count" });
    const increment = createEvent<number>("increment");
    $count.on(increment, (count, amount) => count + amount);

    const scope = fork();
    timeline.subscribeScope({ id: "scope:1", scope, name: "app" });

    await allSettled(increment, { scope, params: 5 });
    await drain();

    const incrementRow = events.find((event) => event.nodeName === "increment");
    expect(incrementRow).toBeDefined();
    expect(incrementRow).toMatchObject({
      nodeType: "event",
      scopeId: "scope:1",
      scopeName: "app",
      failed: false,
      stopped: false,
      breakpoint: false,
      duration: 0,
    });
    expect(incrementRow?.payload.preview).toBe("5");
    expect(incrementRow?.result.preview).toBe("5");
    expect(incrementRow?.id).toMatch(/^timeline:\d+$/);

    // No operation-node rows leak into the timeline.
    expect(events.some((event) => event.nodeType === "on")).toBe(false);
    // No derived service sub-unit rows leak in (store's "updates", etc.).
    expect(events.some((event) => event.nodeName === "updates")).toBe(false);

    timeline.dispose();
  });

  it("emits one primary row per effect call instead of every derived sub-unit", async () => {
    const events: DevtoolsTimelineEvent[] = [];
    const timeline = createEffectorTimeline({ onEvent: (event) => events.push(event) });

    const okFx = createEffect({ name: "okFx", handler: async (value: number) => value * 2 });

    const scope = fork();
    timeline.subscribeScope({ id: "scope:1", scope, name: "app" });

    await allSettled(okFx, { scope, params: 4 });
    await drain();

    expect(events.filter((event) => event.nodeName === "okFx")).toHaveLength(1);
    for (const noisy of ["updates", "inFlight", "pending", "finally", "done", "doneData"]) {
      expect(events.some((event) => event.nodeName === noisy)).toBe(false);
    }

    timeline.dispose();
  });

  it("flags failed effects", async () => {
    const events: DevtoolsTimelineEvent[] = [];
    const timeline = createEffectorTimeline({ onEvent: (event) => events.push(event) });

    const boomFx = createEffect({
      name: "boomFx",
      handler: async () => {
        throw new Error("kaboom");
      },
    });

    const scope = fork();
    timeline.subscribeScope({ id: "scope:1", scope, name: "app" });

    await allSettled(boomFx, { scope }).catch(() => {});
    await drain();

    const failedRow = events.find((event) => event.failed);
    expect(failedRow).toBeDefined();
    expect(failedRow?.result.preview).toContain("kaboom");
    // Failure rows are still attributed to user-facing units, not op nodes.
    expect(events.some((event) => event.nodeType === "on" || event.nodeType === "map")).toBe(false);

    timeline.dispose();
  });
});

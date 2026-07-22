import { describe, expect, it, vi } from "vitest";
import { allSettled, createEffect, fork } from "effector";
import type { DevtoolsTimelineEvent } from "@virentia/core/devtools";
import { createEffectorTimeline } from "../../lib/effector/timeline";

/**
 * Timeline rows must resolve display names the same way the graph does
 * (name → factory → loc → sid → #id, numeric auto-names treated as missing) —
 * otherwise anonymous effects show up as bare numbers ("5278") in Call history
 * even though the graph names them properly.
 */
async function runAnonymousEffect(
  timelineOptions: Omit<Parameters<typeof createEffectorTimeline>[0], "onEvent">,
): Promise<DevtoolsTimelineEvent[]> {
  const events: DevtoolsTimelineEvent[] = [];
  const timeline = createEffectorTimeline({
    onEvent: (event) => events.push(event),
    ...timelineOptions,
  });

  const anonFx = createEffect(async () => "ok");
  const scope = fork();
  timeline.subscribeScope(null);
  await allSettled(anonFx, { scope, params: undefined });
  // scope-less inspect misses scoped runs — run once without scope too
  await anonFx(undefined).catch(() => {});

  timeline.dispose();
  return events;
}

describe("timeline naming", () => {
  it("an anonymous effect never renders as a bare number", async () => {
    const events = await runAnonymousEffect({});

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.nodeName).not.toMatch(/^\d+$/);
    }
  });

  it("uses the graph's unit description (factory) for the row name", async () => {
    const describeUnit = vi.fn(() => ({ derived: false, factory: "cartModel" }));
    const events = await runAnonymousEffect({ describeUnit });

    expect(describeUnit).toHaveBeenCalled();
    expect(events.some((event) => event.nodeName === "cartModel.effect")).toBe(true);
  });

  it("applies the app composeName policy to timeline rows", async () => {
    const events = await runAnonymousEffect({
      describeUnit: () => ({ derived: false, factory: "cartModel" }),
      composeName: ({ factory, type }) => (factory ? `${factory}>${type}` : undefined),
    });

    expect(events.some((event) => event.nodeName === "cartModel>effect")).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";

const modelsModule = vi.hoisted(() => ({ loads: 0 }));

vi.mock("@virentia/core/models", () => {
  modelsModule.loads += 1;

  return {
    collection: vi.fn(),
    isModelDefinition: vi.fn(() => false),
    isModelInstance: vi.fn(() => false),
    isModelQuery: vi.fn(() => false),
    queryReactivity: vi.fn(),
    subscribeInstance: vi.fn(),
  };
});

describe("root entry isolation", () => {
  it("does not load the optional @virentia/core/models subpath", async () => {
    await import("../../lib/index");

    expect(modelsModule.loads).toBe(0);
  });
});

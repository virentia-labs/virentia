// @vitest-environment node

import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import { buildStart } from "../start/node";

vi.mock("vite", () => ({ build: vi.fn(async () => undefined) }));

beforeEach(() => {
  vi.mocked(build)
    .mockReset()
    .mockResolvedValue(undefined as never);
});

describe("buildStart", () => {
  it("builds client and server from the same resolved root and config", async () => {
    const root = resolve(process.cwd(), "examples/start");
    const configFile = resolve(root, "config/vite.custom.ts");

    await buildStart({ root, configFile: "config/vite.custom.ts" });

    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenNthCalledWith(1, {
      root,
      configFile,
      build: {
        outDir: resolve(root, "dist/client"),
        emptyOutDir: true,
      },
    });
    expect(build).toHaveBeenNthCalledWith(2, {
      root,
      configFile,
      build: {
        ssr: true,
        outDir: resolve(root, "dist/server"),
        emptyOutDir: true,
        rolldownOptions: {
          input: "virtual:virentia-start/server",
          output: { entryFileNames: "entry-server.mjs" },
        },
      },
    });
  });

  it("waits for the client build before starting the server build", async () => {
    let completeClientBuild!: () => void;
    vi.mocked(build).mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof build>>>((resolveBuild) => {
          completeClientBuild = () => resolveBuild(undefined as never);
        }),
    );

    const pendingBuild = buildStart();
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    completeClientBuild();
    await pendingBuild;

    expect(build).toHaveBeenCalledTimes(2);
  });
});

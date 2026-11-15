// @vitest-environment node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createServer } from "vite";
import { renderDocument } from "../start/document";
import virentiaStart from "../start/vite";

const uiRoot = fileURLToPath(new URL("..", import.meta.url));
const exampleRoot = resolve(uiRoot, "examples/start");
const source = (path: string) => resolve(uiRoot, path);

function createTestServer(root: string) {
  return createServer({
    configFile: false,
    root,
    plugins: virentiaStart({ title: "Virentia <Start>" }),
    resolve: {
      alias: [
        { find: "@virentia/ui/jsx-runtime", replacement: source("lib/jsx-runtime.ts") },
        { find: "@virentia/ui/jsx-dev-runtime", replacement: source("lib/jsx-dev-runtime.ts") },
        { find: "@virentia/ui/start", replacement: source("start/index.ts") },
        { find: "@virentia/ui/react", replacement: source("lib/react-server.ts") },
        { find: "@virentia/ui/vue", replacement: source("lib/vue-server.ts") },
        { find: "@virentia/ui", replacement: source("lib/index.ts") },
        { find: "@virentia/react", replacement: source("../react/lib/index.ts") },
        { find: "@virentia/vue", replacement: source("../vue/lib/index.ts") },
        { find: "@virentia/core/internal", replacement: source("../core/lib/internal.ts") },
        { find: "@virentia/core/models", replacement: source("../core/lib/models.ts") },
        { find: "@virentia/core", replacement: source("../core/lib/index.ts") },
      ],
    },
    server: { middlewareMode: true, ws: false },
  });
}

describe("start Vite convention", () => {
  it("renders one page at any path and keeps server loader out of the client entry", async () => {
    const server = await createTestServer(exampleRoot);
    try {
      const entry = (await server.ssrLoadModule("virtual:virentia-start/server")) as {
        documentTitle: string;
        renderRequest(url: string, request: unknown): Promise<{ html: string; payload: string }>;
      };
      expect(entry.documentTitle).toBe("Virentia <Start>");
      const page = await entry.renderRequest("/people/ada?hello=Hi%20Ada", { headers: {} });
      expect(page.html).toContain("Hi Ada");
      expect(page.html).toContain("/people/ada");
      expect(JSON.parse(page.payload).data).toEqual({
        path: "/people/ada",
        greeting: "Hi Ada",
      });
      const document = renderDocument(page, {
        title: entry.documentTitle,
        clientEntryUrl: "/assets/client.js",
        stylesheets: ["/assets/style.css"],
      });
      expect(document).toContain("Virentia &lt;Start&gt;");
      expect(document).toContain('href="/assets/style.css"');
      expect(document).toContain('src="/assets/client.js"');

      const client = await server.transformRequest("virtual:virentia-start/client");
      expect(client?.code).toContain("hydratePage");
      expect(client?.code).not.toContain("load.server.ts");
    } finally {
      await server.close();
    }
  }, 20_000);

  it("isolates root-created model graphs in simultaneous SSR requests", async () => {
    const server = await createTestServer(resolve(uiRoot, "examples/start-mixed"));
    try {
      const entry = (await server.ssrLoadModule("virtual:virentia-start/server")) as {
        renderRequest(url: string, request: unknown): Promise<{ html: string; payload: string }>;
      };
      const [first, second] = await Promise.all([
        entry.renderRequest("/?count=3", { headers: {} }),
        entry.renderRequest("/?count=7", { headers: {} }),
      ]);
      for (const [page, count] of [
        [first, 3],
        [second, 7],
      ] as const) {
        expect(page.html).toContain("First");
        expect(page.html).toContain("Second");
        expect(page.html).toContain(`<!--ui:t-->${count}`);
        expect(JSON.parse(page.payload).data).toEqual({ count });
        expect(Object.values(JSON.parse(page.payload).snapshot)).toContain(count);
      }
    } finally {
      await server.close();
    }
  }, 20_000);
});

import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import virentiaUI from "../../vite";

function serverRendering(): Plugin {
  return {
    name: "virentia-ui-ssr-demo",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = request.originalUrl ?? request.url ?? "/";
        if (new URL(url, "http://localhost").pathname !== "/") {
          next();
          return;
        }
        try {
          const entry = await server.ssrLoadModule("/entry-server.tsx");
          const document = await server.transformIndexHtml(url, entry.renderDocument(url));
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(document);
        } catch (error) {
          if (error instanceof Error) server.ssrFixStacktrace(error);
          next(error);
        }
      });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  appType: "custom",
  // configResolved supplies the same source root to both client and SSR transforms.
  plugins: [virentiaUI({ namespace: "ssr-demo" }), serverRendering()],
  resolve: {
    alias: {
      "@virentia/ui/jsx-runtime": fileURLToPath(new URL("../../lib/jsx-runtime.ts", import.meta.url)),
      "@virentia/ui/jsx-dev-runtime": fileURLToPath(new URL("../../lib/jsx-dev-runtime.ts", import.meta.url)),
      "@virentia/ui/server": fileURLToPath(new URL("../../lib/server.ts", import.meta.url)),
      "@virentia/ui": fileURLToPath(new URL("../../lib/index.ts", import.meta.url)),
      "@virentia/core/internal": fileURLToPath(
        new URL("../../../core/lib/internal.ts", import.meta.url),
      ),
      "@virentia/core/models": fileURLToPath(
        new URL("../../../core/lib/models.ts", import.meta.url),
      ),
      "@virentia/core": fileURLToPath(new URL("../../../core/lib/index.ts", import.meta.url)),
    },
  },
  ssr: { noExternal: ["@virentia/ui", "@virentia/core"] },
  server: { host: "127.0.0.1" },
});

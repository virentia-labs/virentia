import { defineConfig } from "vite";
import { installVirentiaInspectorRelay } from "./lib/server/relay";

export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: "dist/app",
  },
  preview: {
    host: "127.0.0.1",
    port: 4174,
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
  },
  plugins: [
    {
      name: "virentia-inspector-relay",
      configureServer(server) {
        if (!server.httpServer) {
          return;
        }

        const closeRelay = installVirentiaInspectorRelay(server.httpServer);

        server.httpServer.once("close", closeRelay);
      },
    },
  ],
});

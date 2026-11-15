import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import virentiaUI from "../../vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [virentiaUI()],
  resolve: {
    alias: {
      "@virentia/ui/jsx-runtime": fileURLToPath(new URL("../../lib/jsx-runtime.ts", import.meta.url)),
      "@virentia/ui/jsx-dev-runtime": fileURLToPath(new URL("../../lib/jsx-dev-runtime.ts", import.meta.url)),
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
  build: { outDir: "../../playground-dist", emptyOutDir: true },
});

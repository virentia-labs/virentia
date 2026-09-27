import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import virentiaUI from "../../compiler/vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [virentiaUI()],
  resolve: {
    alias: {
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

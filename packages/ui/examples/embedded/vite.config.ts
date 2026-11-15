import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import virentiaUI from "../../vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [virentiaUI()],
  build: { outDir: "dist", emptyOutDir: true },
});

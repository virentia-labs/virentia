import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "lib/index.ts",
    devtools: "lib/devtools.ts",
    internal: "lib/internal.ts",
    models: "lib/models.ts",
    utils: "lib/utils.ts",
    "compiler/index": "compiler/index.ts",
    "compiler/vite": "compiler/vite.ts",
  },
  outDir: "dist",
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
});

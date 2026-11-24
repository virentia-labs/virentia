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
  // Keep initialization with the module that owns it. Merging events and
  // stores into one shared chunk prevents consumers from dropping store setup.
  unbundle: true,
  outputOptions(options, format) {
    // Native require() keeps shared bundles and its existing load structure.
    if (format === "cjs") options.preserveModules = false;
  },
  dts: true,
  clean: true,
});

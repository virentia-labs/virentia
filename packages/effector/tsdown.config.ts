import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["lib/index.ts", "lib/internal.ts"],
  outDir: "dist",
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  deps: {
    neverBundle: ["@virentia/core", "effector"],
  },
});

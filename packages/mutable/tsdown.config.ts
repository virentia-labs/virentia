import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["lib/index.ts"],
  outDir: "dist",
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  deps: {
    neverBundle: ["@virentia/core", "@virentia/core/internal"],
  },
});

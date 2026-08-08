import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["lib/index.ts", "lib/devtools.ts", "lib/internal.ts", "lib/models.ts", "lib/utils.ts"],
  outDir: "dist",
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
});

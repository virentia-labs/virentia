import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    cli: "lib/server/cli.ts",
    index: "lib/client/index.ts",
  },
  outDir: "dist",
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      "@mantine/core",
      "@mantine/hooks",
      "@virentia/core",
      "@virentia/core/devtools",
      "@virentia/react",
      "@xyflow/react",
      "react",
      "react-dom",
    ],
  },
});

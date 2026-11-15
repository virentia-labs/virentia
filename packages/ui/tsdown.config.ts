import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "lib/index.ts",
    server: "lib/server.ts",
    "jsx-runtime": "lib/jsx-runtime.ts",
    "jsx-dev-runtime": "lib/jsx-dev-runtime.ts",
    vite: "vite.ts",
    "start/index": "start/index.ts",
    "start/vite": "start/vite.ts",
    "start/node": "start/node.ts",
    "start/cli": "start/cli.ts",
    react: "lib/react.ts",
    "react/server": "lib/react-server.ts",
    vue: "lib/vue.ts",
    "vue/server": "lib/vue-server.ts",
  },
  outDir: "dist",
  format: ["esm", "cjs"],
  // Descriptions and JSX must stay usable without the DOM renderer's setup.
  unbundle: true,
  outputOptions(options, format) {
    if (format === "cjs") options.preserveModules = false;
  },
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      "@virentia/core",
      "@virentia/core/internal",
      "@virentia/core/models",
      "@virentia/core/compiler",
      "@virentia/core/compiler/vite",
      "@virentia/react",
      "@virentia/vue",
      "@babel/core",
      "react",
      "react-dom",
      "vue",
      "vite",
    ],
  },
});

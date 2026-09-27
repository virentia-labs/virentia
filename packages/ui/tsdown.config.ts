import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "lib/index.ts",
    server: "lib/server.ts",
    "jsx-runtime": "lib/jsx-runtime.ts",
    "jsx-dev-runtime": "lib/jsx-dev-runtime.ts",
    "compiler/index": "compiler/index.ts",
    "compiler/vite": "compiler/vite.ts",
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
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      "@virentia/core",
      "@virentia/core/internal",
      "@virentia/core/models",
      "@virentia/core/compiler",
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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@virentia/core/compiler/vite": resolve(root, "../core/compiler/vite.ts"),
      "@virentia/core/compiler": resolve(root, "../core/compiler/index.ts"),
      "@virentia/core/internal": resolve(root, "../core/lib/internal.ts"),
      "@virentia/core/models": resolve(root, "../core/lib/models.ts"),
      "@virentia/core": resolve(root, "../core/lib/index.ts"),
      "@virentia/ui/jsx-dev-runtime": resolve(root, "lib/jsx-dev-runtime.ts"),
      "@virentia/ui/jsx-runtime": resolve(root, "lib/jsx-runtime.ts"),
      "@virentia/ui/compiler": resolve(root, "compiler/index.ts"),
      "@virentia/ui/start/vite": resolve(root, "start/vite.ts"),
      "@virentia/ui/start": resolve(root, "start/index.ts"),
      "@virentia/ui/react/server": resolve(root, "lib/react-server.ts"),
      "@virentia/ui/react": resolve(root, "lib/react.ts"),
      "@virentia/ui/vue/server": resolve(root, "lib/vue-server.ts"),
      "@virentia/ui/vue": resolve(root, "lib/vue.ts"),
      "@virentia/ui/server": resolve(root, "lib/server.ts"),
      "@virentia/ui": resolve(root, "lib/index.ts"),
    },
  },
  test: {
    cache: false,
    environment: "happy-dom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    typecheck: {
      tsconfig: "./tsconfig.vitest.json",
      include: ["tests/types/**/*.test-d.ts", "tests/types/**/*.test-d.tsx"],
    },
  },
});

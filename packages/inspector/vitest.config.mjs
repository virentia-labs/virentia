import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Most specific first: "@virentia/core/devtools" must win over "@virentia/core".
    alias: [
      {
        find: "@virentia/core/devtools",
        replacement: resolve(root, "../core/lib/devtools.ts"),
      },
      {
        find: "@virentia/core",
        replacement: resolve(root, "../core/lib/index.ts"),
      },
    ],
  },
  test: {
    cache: false,
    include: ["tests/**/*.test.ts"],
    typecheck: {
      tsconfig: "./tsconfig.vitest.json",
      include: ["tests/types/**/*.test-d.ts"],
    },
  },
});

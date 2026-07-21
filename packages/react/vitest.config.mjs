import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@virentia/core/internal": resolve(root, "../core/lib/internal.ts"),
      "@virentia/core": resolve(root, "../core/lib/index.ts"),
    },
  },
  test: {
    cache: false,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    typecheck: {
      tsconfig: "./tsconfig.vitest.json",
      include: ["tests/types/**/*.test-d.ts", "tests/types/**/*.test-d.tsx"],
    },
  },
});

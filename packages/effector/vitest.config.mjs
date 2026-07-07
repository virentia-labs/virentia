import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Most specific first: "@virentia/core/internal" must win over "@virentia/core".
      "@virentia/core/internal": resolve(root, "../core/lib/internal.ts"),
      "@virentia/core": resolve(root, "../core/lib/index.ts"),
    },
  },
  test: {
    cache: false,
    include: ["tests/**/*.test.ts"],
    snapshotFormat: {
      printBasicPrototype: true,
    },
  },
});

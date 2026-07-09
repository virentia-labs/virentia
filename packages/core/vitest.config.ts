import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    cache: false,
    include: ["tests/**/*.test.ts"],
    typecheck: {
      include: ["tests/types/**/*.test-d.ts"],
    },
  },
});

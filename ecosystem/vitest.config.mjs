import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { cache: false, environment: "happy-dom", include: ["tests/**/*.test.ts"], threads: false },
});

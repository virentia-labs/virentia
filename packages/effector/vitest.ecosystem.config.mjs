import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

const inlinePackages = [
  "patronum",
  "@farfetched/core",
  "@argon-router/core",
  "@argon-router/react",
  "@argon-router/paths",
  "@effector-reform/core",
  "@effector-reform/react",
  "@effector-kit/models",
  "@effector-kit/react",
  "effector-action",
  "effector-storage",
  "effector-react",
];

export default defineConfig({
  root,
  resolve: {
    alias: [
      { find: /^@virentia\/effector$/, replacement: resolve(root, "lib/index.ts") },
      { find: /^effector$/, replacement: resolve(root, "lib/index.ts") },
      { find: /^effector\/effector\.(mjs|cjs)$/, replacement: resolve(root, "lib/index.ts") },
      { find: /^@virentia\/core$/, replacement: resolve(root, "../core/lib/index.ts") },
      {
        find: /^regenerator-runtime\/runtime$/,
        replacement: resolve(root, "ecosystem-tests/_compat/regenerator-runtime.ts"),
      },
    ],
  },
  test: {
    cache: false,
    environment: "jsdom",
    globals: true,
    include: ["ecosystem-tests/**/*.test.{ts,tsx}"],
    exclude: [
      "ecosystem-tests/effector-storage/tests/core-validate.test.ts",
      "ecosystem-tests/effector-storage/tests/contract-persist.test.ts",
    ],
    setupFiles: ["ecosystem-tests/setup.ts"],
    threads: false,
    server: {
      deps: {
        inline: inlinePackages,
      },
    },
    snapshotFormat: {
      printBasicPrototype: false,
    },
    testTimeout: 5000,
    hookTimeout: 5000,
  },
});

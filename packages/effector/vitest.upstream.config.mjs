import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const babel = require("@babel/core");
const effectorBabelPlugin = require("effector/babel-plugin");

function effectorBabelTransform() {
  return {
    name: "virentia-effector-upstream-babel",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/packages/effector/upstream-tests/") || !/\.[cm]?[jt]sx?$/.test(id)) {
        return null;
      }

      const factories = [];

      if (id.endsWith("/packages/effector/upstream-tests/fork/factory.ts")) {
        factories.push("@virentia/effector");
      }

      if (id.endsWith("/packages/effector/upstream-tests/fork/factory.test.ts")) {
        factories.push("upstream-tests/fork/factory");
      }

      const result = babel.transformSync(code, {
        filename: id,
        root,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        parserOpts: {
          plugins: ["typescript", "jsx"],
        },
        plugins: [
          [
            effectorBabelPlugin,
            {
              importName: ["effector", "@virentia/effector"],
              factories,
            },
          ],
        ],
      });

      return result ? { code: result.code, map: result.map } : null;
    },
  };
}

export default defineConfig({
  root,
  plugins: [effectorBabelTransform()],
  resolve: {
    alias: [
      { find: /^@virentia\/effector$/, replacement: resolve(root, "lib/index.ts") },
      { find: /^effector$/, replacement: resolve(root, "lib/index.ts") },
      {
        find: /^effector\/fixtures$/,
        replacement: resolve(root, "upstream-tests/_compat/fixtures.ts"),
      },
      {
        find: /^effector\/fixtures\/showstep$/,
        replacement: resolve(root, "upstream-tests/_compat/showstep.ts"),
      },
      {
        find: /^effector\/inspect$/,
        replacement: resolve(root, "upstream-tests/_compat/inspect.ts"),
      },
      { find: /^most$/, replacement: resolve(root, "upstream-tests/_compat/most.ts") },
      { find: /^rxjs$/, replacement: resolve(root, "upstream-tests/_compat/rxjs.ts") },
      { find: "@virentia/core", replacement: resolve(root, "../core/lib/index.ts") },
    ],
  },
  test: {
    cache: false,
    globals: false,
    include: ["upstream-tests/**/*.test.ts"],
    exclude: [
      "upstream-tests/inspect.test.ts",
      "upstream-tests/naming.test.ts",
      "upstream-tests/observable.test.ts",
      "upstream-tests/error-stacks/debug_traces_enabled.scope-serialize-messages.test.ts",
      "upstream-tests/error-stacks/debug_traces_enabled.skip-void-messages.test.ts",
      "upstream-tests/fork/index.test.ts",
    ],
    snapshotFormat: {
      printBasicPrototype: true,
    },
    testTimeout: 3000,
    hookTimeout: 3000,
  },
});

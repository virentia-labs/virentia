// Check the published dist boundary, including runtime initialization after DCE.
// Run check-ecosystem.mjs --phase build first; dependencies and links must exist.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, writeFile, rm, copyFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ecosystem = path.join(root, "ecosystem");
const require = createRequire(import.meta.url);
const toolRequire = createRequire(require.resolve("tsdown/package.json"));
const { rolldown, VERSION } = await import(pathToFileURL(toolRequire.resolve("rolldown")));
const { values } = parseArgs({ options: { out: { type: "string" } } });
const output = path.resolve(values.out ?? path.join(tmpdir(), `virentia-bundles-${Date.now()}`));
const cache = path.join(ecosystem, "node_modules/.cache", `virentia-bundles-${process.pid}`);
await mkdir(output, { recursive: true });
await mkdir(cache, { recursive: true });
const report = {
  bundler: `rolldown@${VERSION}`,
  node: process.version,
  sizes: [],
  tests: [],
  complete: false,
  success: false,
};
const save = () =>
  writeFile(path.join(output, "summary.json"), JSON.stringify(report, null, 2) + "\n");
const hosts = ["react", "react-dom", "vue", "effector", "history", "vitest"];
const peer = (id) => hosts.some((name) => id === name || id.startsWith(name + "/"));

async function bundle(input, filename, external = peer, format = "esm", absentFunctions = []) {
  const warnings = [];
  const build = await rolldown({
    input,
    platform: "browser",
    tsconfig: false,
    external,
    transform: { define: { "process.env.NODE_ENV": '"production"' } },
    onwarn: (warning) => {
      const id = warning.id ?? warning.loc?.file;
      warnings.push({
        code: warning.code,
        id: id ? path.resolve(id) : undefined,
        message: warning.message,
      });
    },
  });
  try {
    if (absentFunctions.length) {
      const plain = await build.generate({ format, minify: false });
      const code = plain.output.filter((item) => item.type === "chunk").map((item) => item.code).join("\n");
      for (const name of absentFunctions)
        assert(!new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(code), `Unused dynamic-model code retained: ${name}`);
    }
    const result = await build.generate({ format, minify: true });
    const chunks = result.output.filter((item) => item.type === "chunk");
    assert.equal(chunks.length, 1, `Unexpected code splitting for ${filename}`);
    const chunk = chunks[0];
    const modules = Object.keys(chunk.modules);
    // Rolldown may warn about import.meta while parsing a module later removed
    // by DCE. Such a module is absent from the output; live warnings still fail.
    const liveWarnings = warnings.filter(
      (warning) =>
        !(warning.code === "EMPTY_IMPORT_META" && warning.id && !modules.includes(warning.id)),
    );
    assert.deepEqual(liveWarnings, [], `Unexpected bundle warnings for ${filename}`);
    assert(
      !modules.some((id) => /\/packages\/[^/]+\/lib\//.test(id)),
      "Source alias bypassed dist",
    );
    await writeFile(filename, chunk.code);
    return { code: chunk.code, modules, exports: chunk.exports, imports: chunk.imports };
  } finally {
    await build.close();
  }
}

try {
  // These consumer imports deliberately keep the requested API live. An empty
  // consumer separately checks that unused package imports can disappear.
  for (const [name, spec, api] of [
    ["core-all", "@virentia/core", "*"],
    ["core-store", "@virentia/core", "{ store }"],
    ["core-event", "@virentia/core", "{ event }"],
    ["core-reaction", "@virentia/core", "{ reaction }"],
    ["ui-ref", "@virentia/ui", "{ ref }"],
    ["ui-render", "@virentia/ui", "{ render, component, h }"],
    ["vue-unit", "@virentia/vue", "{ useUnit }"],
    ["storage-memory", "@virentia/storage-core", "{ memory }"],
  ]) {
    const input = path.join(cache, `${name}.mjs`);
    await writeFile(input, `export ${api} from ${JSON.stringify(spec)};\n`);
    const result = await bundle(input, path.join(output, `${name}.mjs`));
    if (name === "core-event" || name === "core-reaction") {
      assert(
        !result.modules.some((id) => id.endsWith("/units/store.mjs")),
        `${name} retained stores`,
      );
    }
    if (name === "ui-render") {
      assert(
        !result.modules.some(
          (id) => id.includes("@sinclair") || /\/models\/(collection|definition)\.mjs$/.test(id),
        ),
        "UI retained model factories merely for recognition",
      );
      assert(
        !result.modules.some((id) => /\/(foreign-mount|foreign-tree)\.mjs$/.test(id)),
        "Native browser UI retained host-adapter mounting",
      );
    }
    report.sizes.push({
      name,
      min: Buffer.byteLength(result.code),
      gzip: gzipSync(result.code, { level: 9 }).length,
      modules: result.modules,
      exports: result.exports,
    });
    console.log(`${name}: ${report.sizes.at(-1).min} min / ${report.sizes.at(-1).gzip} gzip`);
  }
  for (const spec of [
    "@virentia/core",
    "@virentia/core/models",
    "@virentia/ui",
    "@virentia/forms",
    "@virentia/forms/models",
    "@virentia/storage-core",
    "@virentia/net-core",
    "@virentia/router",
  ]) {
    const input = path.join(cache, "unused.mjs");
    await writeFile(input, `import ${JSON.stringify(spec)}; export const alive = true;\n`);
    const result = await bundle(
      input,
      path.join(output, `${spec.slice(10).replaceAll("/", "-")}-unused.mjs`),
    );
    assert.equal(result.modules.length, 1, `Unused ${spec} retained runtime modules`);
  }
  for (const format of ["esm", "cjs"]) {
    const input = path.join(cache, "descriptions.mjs");
    const filename = path.join(output, `descriptions.${format === "esm" ? "mjs" : "cjs"}`);
    await writeFile(
      input,
      'export { h } from "@virentia/ui"; export { jsx, jsxs, Fragment } from "@virentia/ui/jsx-runtime";\n',
    );
    const result = await bundle(input, filename, peer, format);
    assert(
      !result.modules.some(
        (id) => /\/(runtime|lifetime|component)\.mjs$/.test(id) || /\/units\/|\/models\//.test(id),
      ),
      "Inert JSX imported the renderer or state runtime",
    );
    const { h, jsx, jsxs } =
      format === "cjs" ? require(filename) : await import(pathToFileURL(filename));
    let title = "first",
      reads = 0;
    const props = {
      get title() {
        reads++;
        return title;
      },
    };
    const description = h("div", props, "text");
    assert.deepEqual(Object.keys(description), ["type", "props"]);
    assert.equal(reads, 0);
    assert.equal(description.props.children, "text");
    assert.equal(description.props.title, "first");
    title = "second";
    assert.equal(description.props.title, "second");
    assert.equal(reads, 2);
    const unkeyed = jsx("span", props);
    assert.equal(unkeyed.props, props);
    assert.equal(jsx("span", props, "row").props.key, "row");
    assert.equal(jsx, jsxs);
    assert.equal(
      Object.getPrototypeOf(Object.getPrototypeOf(description)),
      Object.getPrototypeOf(Object.getPrototypeOf(unkeyed)),
    );
    report.tests.push(
      `inert JSX ${format}: lazy/live props, identity and keys without the renderer`,
    );
  }
  for (const format of ["esm", "cjs"]) {
    const input = path.join(cache, "static-model.mjs"),
      filename = path.join(output, `static-model.${format === "esm" ? "mjs" : "cjs"}`);
    await writeFile(input, 'export { scope, scoped } from "@virentia/core"; export { staticModel, f } from "@virentia/core/models";\n');
    await bundle(input, filename, peer, format, ["instantiateDynamic", "initializeDynamicModelValues"]);
    const { scope, scoped, staticModel, f } = format === "cjs" ? require(filename) : await import(pathToFileURL(filename));
    const Model = staticModel({ name: "StaticOnlyBundle", data: { count: f.number(0) } });
    const first = scope(), second = scope();
    const a = scoped(first, () => Model.create({ id: "same" }));
    const b = scoped(second, () => Model.create({ id: "same" }));
    try {
      a.count.value = 7;
      assert.equal(b.count.value, 0);
      assert.equal(scoped(first, () => Model.instances.count), 1);
      await a.dispose();
      const fresh = scoped(first, () => Model.create({ id: "same" }));
      try { assert.equal(fresh.count.value, 0); } finally { await fresh.dispose(); }
    } finally { await a.dispose(); await b.dispose(); }
    report.tests.push(`staticModel ${format}: scope isolation, disposal and reuse without the dynamic backend`);
  }
  for (const format of ["esm", "cjs"]) {
    const input = path.join(cache, "models-typebox.mjs"),
      filename = path.join(output, `models-typebox.${format === "esm" ? "mjs" : "cjs"}`);
    if (format === "esm") {
      // The ecosystem itself has no TypeBox dependency. Reuse Core's peer for
      // this consumer so its schemas and model validation share one registry.
      const peers = path.join(cache, "node_modules/@sinclair");
      await mkdir(peers, { recursive: true });
      await symlink(
        path.join(root, "packages/core/node_modules/@sinclair/typebox"),
        path.join(peers, "typebox"),
        "dir",
      );
    }
    await writeFile(
      input,
      [
        'export { scope, scoped } from "@virentia/core";',
        'export { f, staticModel, trait } from "@virentia/core/models";',
        'export { Kind, FormatRegistry, TypeRegistry } from "@sinclair/typebox";',
        'export { TypeSystemPolicy } from "@sinclair/typebox/system";',
      ].join("\n"),
    );
    const result = await bundle(input, filename, peer, format);
    assert(
      !result.modules.some((id) =>
        /\/type\/(type\/index|extends\/extends-check|module\/compute)\.mjs$/.test(id),
      ),
      "Models retained TypeBox's complete builder namespace",
    );
    const {
      scope,
      scoped,
      f,
      staticModel,
      trait,
      Kind,
      FormatRegistry,
      TypeRegistry,
      TypeSystemPolicy,
    } = format === "cjs" ? require(filename) : await import(pathToFileURL(filename));
    const kind = "VirentiaBundlePositive",
      stringFormat = "virentia-bundle-format";
    const previous = TypeSystemPolicy.InstanceMode;
    TypeRegistry.Set(kind, (_schema, value) => typeof value === "number" && value > 0);
    FormatRegistry.Set(stringFormat, (value) => value.startsWith("valid:"));
    let row, other;
    try {
      TypeSystemPolicy.InstanceMode = "freeze";
      assert(Object.isFrozen(f.object({ title: f.string() }).schema));
      TypeSystemPolicy.InstanceMode = previous;
      const Generic = trait({ data: { items: f.array(f.arg(0)) } });
      const Row = staticModel({
        with: [Generic(f.integer())],
        data: {
          positive: f.from({ [Kind]: kind }),
          formatted: f.from({ [Kind]: "String", type: "string", format: stringFormat }),
        },
      });
      const first = scope(),
        second = scope();
      row = scoped(first, () =>
        Row.create({ id: "same", items: [1, 2], positive: 1, formatted: "valid:first" }),
      );
      other = scoped(second, () =>
        Row.create({ id: "same", items: [3], positive: 2, formatted: "valid:second" }),
      );
      assert.deepEqual(row.items.value, [1, 2]);
      assert.deepEqual(other.items.value, [3]);
      scoped(first, () => {
        assert.throws(
          () => Row.create({ items: [1.5], positive: 1, formatted: "valid:x" }),
          /invalid "items"/,
        );
        assert.throws(
          () => Row.create({ items: [1], positive: -1, formatted: "valid:x" }),
          /invalid "positive"/,
        );
        assert.throws(
          () => Row.create({ items: [1], positive: 1, formatted: "invalid" }),
          /invalid "formatted"/,
        );
      });
    } finally {
      TypeSystemPolicy.InstanceMode = previous;
      await row?.dispose();
      await other?.dispose();
      TypeRegistry.Delete(kind);
      FormatRegistry.Delete(stringFormat);
    }
    assert.equal(row.alive, false);
    assert.equal(other.alive, false);
    report.tests.push(
      `models/TypeBox ${format}: generics, raw schemas, live registries/policy, scope isolation and disposal`,
    );
  }
  for (const format of ["esm", "cjs"]) {
    const input = path.join(cache, "memory.mjs"),
      filename = path.join(output, `memory.${format === "esm" ? "mjs" : "cjs"}`);
    await writeFile(input, 'export { memory } from "@virentia/storage-core";\n');
    const result = await bundle(input, filename, peer, format);
    assert(
      !result.modules.some((id) => id.startsWith(path.join(root, "packages/core") + path.sep)),
      "memory imported Core",
    );
    const { memory } = format === "cjs" ? require(filename) : await import(pathToFileURL(filename));
    const box = memory([["key", 1]]),
      changes = [];
    const unsubscribe = box.watch("key", (value) => changes.push(value));
    box.set("key", 2);
    box.set("key", undefined);
    unsubscribe();
    box.set("key", 3);
    assert.deepEqual(changes, [2, undefined]);
    assert.equal(box.get("key"), 3);
    report.tests.push(`memory ${format}: watches/removal/unsubscribe without Core`);
  }

  // Reuse the actual ecosystem assertions. Bundling each suite separately
  // catches missing registration, duplicated scopes, adapters and nested SSR
  // semantics in consumer output, rather than only testing unbundled modules.
  for (const name of [
    "interoperability",
    "collection-fields",
    "nested-fields-hydration",
    "model-relations",
    "ui-native-features",
    "ui-host-adapters",
    "model-kinds",
  ]) {
    const filename = path.join(cache, `${name}.test.mjs`);
    await bundle(path.join(ecosystem, "tests", `${name}.test.ts`), filename);
    await copyFile(filename, path.join(output, `${name}.test.mjs`));
  }
  const config = path.join(cache, "vitest.config.mjs");
  await writeFile(
    config,
    `export default ${JSON.stringify({
      root: ecosystem,
      test: {
        environment: "happy-dom",
        threads: false,
        cache: false,
        exclude: [],
        include: [path.relative(ecosystem, cache).split(path.sep).join("/") + "/*.test.mjs"],
      },
    })};\n`,
  );
  const child = spawn(
    process.execPath,
    [
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      config,
      "--threads",
      "false",
    ],
    {
      cwd: ecosystem,
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const parts = [];
  child.stdout.on("data", (data) => parts.push(data));
  child.stderr.on("data", (data) => parts.push(data));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 180000);
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  clearTimeout(timeout);
  await writeFile(path.join(output, "runtime.log"), Buffer.concat(parts));
  assert.equal(exitCode, 0, `Bundled ecosystem tests failed: ${path.join(output, "runtime.log")}`);
  report.tests.push("15 ecosystem tests after production minification and tree shaking");
  report.success = true;
} catch (error) {
  report.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  report.complete = true;
  await save();
  await rm(cache, { recursive: true, force: true });
  console.log(`Report: ${output}`);
}

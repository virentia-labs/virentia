import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { domModelOverlay } from "./dom-model-overlay.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(root);
const depsIndex = process.argv.indexOf("--deps");
const deps =
  depsIndex < 0 ? path.join(root, "node_modules") : path.resolve(process.argv[depsIndex + 1]);
const { build } = await import(pathToFileURL(path.join(deps, "esbuild/lib/main.js")).href);
const variant = process.env.AUDIT_VARIANT ?? "current";
if (!/^[a-z0-9-]+$/i.test(variant)) throw new Error("Invalid build name");
const rows = Number(process.env.AUDIT_ROWS ?? 1000);
const stride = Number(process.env.AUDIT_STRIDE ?? 10);
if (!Number.isSafeInteger(rows) || rows < 1 || rows > 100000 ||
    !Number.isSafeInteger(stride) || stride < 1 || rows % stride)
  throw new Error("Rows must be 1..100000 and divisible by the positive integer stride");
const renderDiagnosticOverlay = process.env.AUDIT_RENDER_DIAGNOSTIC === "1"
  ? (await import("./render-diagnostic.mjs")).renderDiagnosticOverlay
  : undefined;
mkdirSync(path.join(root, ".build"), { recursive: true });
let frozenCoreOverlay;
if (process.env.AUDIT_CORE_SOURCE_MAP) {
  const sourceMapPath = path.resolve(process.env.AUDIT_CORE_SOURCE_MAP);
  const sourceMap = JSON.parse(readFileSync(sourceMapPath, "utf8"));
  const sources = new Map(sourceMap.sources.map((source, index) => [
    path.resolve(path.dirname(sourceMapPath), source), sourceMap.sourcesContent[index],
  ]));
  for (const source of ["units/store.ts", "scope/native.ts", "kernel/scoped-edges.ts", "models/definition.ts"])
    if (!sources.has(path.join(repo, "packages/core/lib", source)))
      throw Error(`Frozen Core source is missing: ${source}`);
  frozenCoreOverlay = {
    name: "audit-frozen-core",
    setup(build) {
      build.onLoad({ filter: /[/\\]packages[/\\]core[/\\]lib[/\\].*\.ts$/ }, args => {
        const contents = sources.get(args.path);
        if (typeof contents === "string")
          return { contents, loader: "ts", resolveDir: path.dirname(args.path) };
      });
    },
  };
}
const staticParentBaseline = process.env.AUDIT_STATIC_PARENT_BASELINE === "1" ? {
  name: "audit-with-static-parent-capture",
  setup(build) {
    build.onLoad({ filter: /[/\\]packages[/\\]core[/\\]lib[/\\]units[/\\]store\.ts$/ }, args => {
      const source = readFileSync(args.path, "utf8");
      const before = "if (!staticParent || !isCollectingNodeSources()) trackNode(source);";
      if (!source.includes(before)) throw Error("Static parent baseline marker is missing");
      return { contents: source.replace(before, "trackNode(source);"), loader: "ts", resolveDir: path.dirname(args.path) };
    });
  },
} : undefined;
const alias = Object.fromEntries(
  Object.entries({
    "@virentia/ui": "ui/lib/index.ts",
    "@virentia/ui/jsx-runtime":
      process.env.AUDIT_LEGACY_JSX === "1"
        ? "../benchmarks/legacy-jsx-runtime.ts"
        : "ui/lib/jsx-runtime.ts",
    "@virentia/core/models": "core/lib/models.ts",
    "@virentia/core/internal": "core/lib/internal.ts",
    "@virentia/core": "core/lib/index.ts",
  }).map(([name, file]) => [name, path.join(repo, "packages", file)]),
);

for (const [name, platform, target] of [
  ["node", "node", "node22"],
  ["library", "node", "node22"],
  ["cache", "node", "node22"],
  ["graph", "node", "node22"],
  ["graph-compare", "node", "node22"],
  ["profile-models", "node", "node22"],
  ["instances", "node", "node22"],
  ["registries", "node", "node22"],
  ["relations", "node", "node22"],
  ["ui", "browser", "es2022"],
]) {
  if (process.env.AUDIT_HARNESS && process.env.AUDIT_HARNESS !== name) continue;
  if (process.env.AUDIT_UI_ONLY === "1" && name !== "ui") continue;
  await build({
    entryPoints: [path.join(root, `${name}.harness.ts`)],
    outfile: path.join(root, ".build", `${name}-${variant}-minified.mjs`),
    bundle: true,
    platform,
    format: "esm",
    target,
    minify: !process.argv.includes("--profile"),
    sourcemap: (process.env.AUDIT_RENDER_DIAGNOSTIC === "1" || process.env.AUDIT_SOURCE_MAP === "1") && name === "ui" ? "external" : false,
    define: {
      VIRENTIA_BENCH_ROWS: String(rows),
      VIRENTIA_BENCH_STRIDE: String(stride),
      "process.env.NODE_ENV": '"production"',
      "process.env.VIRENTIA_BENCH_JSX": JSON.stringify(process.env.AUDIT_JSX === "1" ? "1" : "0"),
      "process.env.VIRENTIA_BENCH_REACT_JSX": JSON.stringify(process.env.AUDIT_REACT_JSX === "1" ? "1" : "0"),
      "process.env.VIRENTIA_BENCH_DOM_MODEL": JSON.stringify(
        process.env.AUDIT_DOM_MODEL === "1" ? "1" : "0",
      ),
      "process.env.VIRENTIA_BENCH_NAMED_MODEL": JSON.stringify(
        process.env.AUDIT_NAMED_MODEL === "1" ? "1" : "0",
      ),
    },
    nodePaths: [deps],
    alias,
    plugins: [
      ...(staticParentBaseline ? [staticParentBaseline] : []),
      ...(frozenCoreOverlay ? [frozenCoreOverlay] : []),
      ...(process.env.AUDIT_DOM_MODEL === "1" ? [domModelOverlay] : []),
      ...(process.env.AUDIT_RENDER_DIAGNOSTIC === "1" && name === "ui"
        ? [renderDiagnosticOverlay({ counts: process.env.AUDIT_RENDER_COUNTS === "1" })]
        : []),
    ],
  });
}
console.log(`Built production benchmarks: ${variant}`);

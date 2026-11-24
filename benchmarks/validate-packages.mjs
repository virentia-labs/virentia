import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(directory);
const tag = process.env.AUDIT_TAG ?? "current";
if (!/^[a-z0-9-]+$/i.test(tag)) throw Error("Invalid validation tag");
const output = path.join(directory, ".build");
mkdirSync(output, { recursive: true });
const env = {
  ...process.env,
  PATH: path.join(root, "node_modules/.bin") + path.delimiter + process.env.PATH,
};
const packages = ["core", "ui", "react", "vue", "mutable", "effector", "inspector"];
const report = {
  node: process.version,
  startedAt: new Date().toISOString(),
  runtime: [],
  types: [],
  builds: [],
};
function run(label, cwd, args) {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 120000 });
  writeFileSync(path.join(output, `validation-${tag}-${label}.log`), result.stdout + result.stderr);
  if (result.error || result.status !== 0)
    throw Error(`${label} failed: ${result.error ?? result.stderr + result.stdout}`);
  console.log(`Passed: ${label}`);
}
for (const name of packages) {
  const cwd = path.join(root, "packages", name);
  const runtime = path.join(output, `validation-${tag}-${name}-runtime.json`);
  run(`${name}-runtime`, cwd, [
    "../../node_modules/vitest/vitest.mjs",
    "run",
    "--threads",
    "false",
    "--reporter=json",
    `--outputFile=${runtime}`,
  ]);
  const result = JSON.parse(readFileSync(runtime));
  if (!result.success) throw Error(`${name}: unsuccessful runtime report`);
  report.runtime.push({
    package: name,
    testsPassed: result.numPassedTests,
    filesPassed: result.testResults.filter((file) => file.status === "passed").length,
    testsFailed: result.numFailedTests,
  });
  const args =
    name === "ui"
      ? ["../../node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.vitest.json"]
      : [
          "../../node_modules/vitest/vitest.mjs",
          "typecheck",
          "--run",
          "--threads",
          "false",
          "--passWithNoTests",
        ];
  run(`${name}-types`, cwd, args);
  report.types.push({ package: name, passed: true });
}
run("root-types", root, ["node_modules/typescript/bin/tsc", "--noEmit"]);
report.rootTypes = true;
// Declarations in adapter packages resolve the freshly built Core entrypoints.
for (const name of packages) {
  run(`${name}-build`, path.join(root, "packages", name), [
    "../../node_modules/tsdown/dist/run.mjs",
  ]);
  report.builds.push({ package: name, passed: true });
}
run("package-smoke", root, ["benchmarks/smoke-packages.mjs"]);
report.smoke = true;
report.finishedAt = new Date().toISOString();
writeFileSync(path.join(output, `validation-${tag}-summary.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

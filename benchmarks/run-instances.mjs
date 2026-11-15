import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("./.build/", import.meta.url);
const builds = (process.env.AUDIT_BUILDS ?? "current").split(",");
const variants = ["plain", "shared-empty", "shared", "dynamic"];
const tasks = builds.flatMap((build) => variants.map((variant) => ({ build, variant })));
const samples = [];
for (let round = 0; round < 9; round++) {
  for (let i = 0; i < tasks.length; i++) {
    const { build, variant } = tasks[(i + round) % tasks.length];
    const result = spawnSync(
      process.execPath,
      ["--expose-gc", fileURLToPath(new URL(`instances-${build}-minified.mjs`, root)), variant],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw Error(result.stderr + result.stdout);
    samples.push({ round, build, ...JSON.parse(result.stdout.trim()) });
  }
}
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  order: "balanced rotation; fresh serial Node process for each sample",
  rounds: 9,
  bundles: Object.fromEntries(
    builds.map((build) => [
      build,
      createHash("sha256")
        .update(readFileSync(new URL(`instances-${build}-minified.mjs`, root)))
        .digest("hex"),
    ]),
  ),
  medians: tasks.map(({ build, variant }) => {
    const selected = samples.filter((row) => row.build === build && row.variant === variant);
    return {
      build,
      variant,
      ...Object.fromEntries(
        ["createMs", "createdHeapBytes", "disposeMs", "setupCalls"].map((key) => [
          key,
          median(selected.map((row) => row[key])),
        ]),
      ),
    };
  }),
  samples,
};
writeFileSync(
  new URL(`${process.env.AUDIT_TAG ?? "current"}-instances-results.json`, root),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));

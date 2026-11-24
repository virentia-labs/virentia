import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = new URL("./.build/", import.meta.url);
const runs = [];
const builds = process.env.AUDIT_BUILDS?.split(",") ?? ["current"];
for (const area of ["models", "core"]) {
  const variants = [...builds, "control"];
  for (let round = 0; round < 9; round++) {
    for (let index = 0; index < variants.length; index++) {
      const variant = variants[(index + round) % variants.length];
      const file = new URL(
        `node-${variant === "control" ? builds.at(-1) : variant}-minified.mjs`,
        root,
      );
      const competitor = area === "models" ? "mobx" : "effector";
      const result = spawnSync(
        process.execPath,
        [
          "--expose-gc",
          fileURLToPath(file),
          area,
          variant === "control" ? competitor : "virentia",
          area === "models" ? "creation" : "dispatch",
        ],
        { encoding: "utf8" },
      );
      if (result.status !== 0) throw Error(result.stderr + result.stdout);
      runs.push({ round, build: variant, ...JSON.parse(result.stdout.trim()) });
    }
  }
}
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const medians = [];
for (const area of ["models", "core"])
  for (const build of [...builds, "control"]) {
    const selected = runs.filter((run) => run.area === area && run.build === build);
    const keys =
      area === "models"
        ? ["createMs", "createdHeapBytes", "activationMs", "activatedHeapBytes"].filter((key) =>
            selected.every((run) => Number.isFinite(run[key])),
          )
        : ["dispatchMs"];
    medians.push({
      area,
      build,
      ...Object.fromEntries(keys.map((key) => [key, median(selected.map((run) => run[key]))])),
    });
  }
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  baseline: "Current source; historical comparisons require previously frozen build bundles",
  rounds: 9,
  order: "balanced rotation, isolated Node process per sample",
  bundles: Object.fromEntries(
    builds.map((build) => [
      build,
      createHash("sha256")
        .update(readFileSync(new URL(`node-${build}-minified.mjs`, root)))
        .digest("hex"),
    ]),
  ),
  medians,
  samples: runs,
};
writeFileSync(
  new URL(`${process.env.AUDIT_TAG ?? "current"}-node-results.json`, root),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));

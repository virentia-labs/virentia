import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const builds = process.env.AUDIT_BUILDS?.split(",") ?? ["current"];
const tag = process.env.AUDIT_TAG ?? builds.at(-1);
if (builds.some((build) => !/^[a-z0-9-]+$/i.test(build)) || !/^[a-z0-9-]+$/i.test(tag))
  throw Error("Invalid build/tag");
const root = new URL("./.build/", import.meta.url),
  rounds = 9;
const observed = process.env.AUDIT_GRAPH_OBSERVED === "1";
const extraInput = process.env.AUDIT_GRAPH_EXTRA_INPUT === "1";
const cases = [
  ...builds.map((build) => ({ build, variant: "virentia" })),
  ...(observed ? [] : ["mobx", "effector"].map((variant) => ({ build: builds.at(-1), variant }))),
];
const samples = [];
for (let round = 0; round < rounds; round++) {
  for (let index = 0; index < cases.length; index++) {
    const entry = cases[(index + round) % cases.length];
    const file = new URL(`graph-compare-${entry.build}-minified.mjs`, root);
    const run = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        fileURLToPath(file),
        entry.variant,
        ...(observed ? ["observed"] : []),
        ...(extraInput ? ["extra"] : []),
      ],
      {
        encoding: "utf8",
      },
    );
    if (run.status !== 0) throw Error(run.stderr + run.stdout);
    samples.push({ round, build: entry.build, ...JSON.parse(run.stdout.trim()) });
  }
}
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  rounds,
  observed,
  extraInput,
  methodology:
    "Serial isolated processes, balanced rotation, identical 8x3 chain, 200 warmups, 2000 updates; official completion boundary plus read, exact 48000 computations and retained-cache/independent-scope checks. Not mapper-only time.",
  bundles: Object.fromEntries(
    builds.map((build) => [
      build,
      createHash("sha256")
        .update(readFileSync(new URL(`graph-compare-${build}-minified.mjs`, root)))
        .digest("hex"),
    ]),
  ),
  medians: cases.map((entry) => ({
    ...entry,
    elapsedMs: median(
      samples
        .filter((sample) => sample.build === entry.build && sample.variant === entry.variant)
        .map((sample) => sample.elapsedMs),
    ),
  })),
  samples,
};
writeFileSync(new URL(`${tag}-graph-compare-results.json`, root), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));

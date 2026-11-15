import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const directory = new URL("./.build/", import.meta.url);
const builds = process.env.AUDIT_BUILDS?.split(",") ?? [process.env.AUDIT_VARIANT ?? "current"];
const build = builds.at(-1);
const cases = [
  ...builds.map((build) => ({ build, variant: "virentia" })),
  ...["mobx", "mobx-cached"].map((variant) => ({ build, variant })),
];
const samples = [];
for (let round = 0; round < 9; round++)
  for (let index = 0; index < cases.length; index++) {
    const { build, variant } = cases[(round + index) % cases.length];
    const file = new URL(`cache-${build}-minified.mjs`, directory);
    const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(file), variant], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw Error(result.stderr + result.stdout);
    samples.push({ round, build, ...JSON.parse(result.stdout.trim()) });
  }
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const medians = cases.map(({ build, variant }) => {
  const selected = samples.filter((sample) => sample.variant === variant && sample.build === build);
  const keys = [
    "createMs",
    "createdHeapBytes",
    "firstReadMs",
    "activatedHeapBytes",
    "cachedReadMs",
    "firstComputations",
    "repeatedComputations",
  ];
  return {
    variant,
    build: builds.length > 1 ? build : undefined,
    ...Object.fromEntries(keys.map((key) => [key, median(selected.map((sample) => sample[key]))])),
    createAndFirstReadMs: median(selected.map((sample) => sample.createMs + sample.firstReadMs)),
  };
});
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  build,
  hash: createHash("sha256")
    .update(readFileSync(new URL(`cache-${build}-minified.mjs`, directory)))
    .digest("hex"),
  bundles: Object.fromEntries(
    builds.map((build) => [
      build,
      createHash("sha256")
        .update(readFileSync(new URL(`cache-${build}-minified.mjs`, directory)))
        .digest("hex"),
    ]),
  ),
  methodology:
    "Supplemental cache-policy comparison; 200 equal computed-read warmups, 9 balanced serial rounds, isolated process per sample. Original benchmark unchanged.",
  medians,
  samples,
};
writeFileSync(
  new URL(`${process.env.AUDIT_TAG ?? build}-cache-results.json`, directory),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));

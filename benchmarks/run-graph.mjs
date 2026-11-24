import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const builds = (process.env.AUDIT_BUILDS ?? "current").split(",");
const directory = new URL("./.build/", import.meta.url);
const samples = [];
for (let round = 0; round < 9; round++) {
  for (let index = 0; index < builds.length; index++) {
    const build = builds[(index + round) % builds.length];
    if (!/^[a-z0-9-]+$/i.test(build)) throw Error("Invalid build");
    const file = new URL(`graph-${build}-minified.mjs`, directory);
    const child = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(file)], {
      encoding: "utf8",
    });
    if (child.status !== 0) throw Error(child.stderr + child.stdout);
    samples.push({ round, build, ...JSON.parse(child.stdout.trim()) });
  }
}
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  rounds: 9,
  methodology:
    "Supplemental internal regression workload, not competitor comparison. Eight independent three-map chains; 200 warmups; 2000 awaited updates with terminal reads included. Balanced serial rounds in fresh processes; checksum, computation counts and scope isolation verified outside timing.",
  bundles: Object.fromEntries(
    builds.map((build) => [
      build,
      createHash("sha256")
        .update(readFileSync(new URL(`graph-${build}-minified.mjs`, directory)))
        .digest("hex"),
    ]),
  ),
  medians: builds.map((build) => {
    const times = samples
      .filter((sample) => sample.build === build)
      .map((sample) => sample.elapsedMs)
      .sort((a, b) => a - b);
    return { build, elapsedMs: times[Math.floor(times.length / 2)] };
  }),
  samples,
};
writeFileSync(
  new URL(`${process.env.AUDIT_TAG ?? "current"}-graph-results.json`, directory),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));

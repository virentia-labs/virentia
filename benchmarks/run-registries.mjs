import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("./.build/", import.meta.url);
const builds = (process.env.AUDIT_BUILDS ?? "current").split(",");
const samples = [];
for (const scopes of [1, 100, 1000]) {
  for (let round = 0; round < 9; round++) {
    for (let i = 0; i < builds.length; i++) {
      const build = builds[(round + i) % builds.length];
      const file = new URL(`registries-${build}-minified.mjs`, root);
      const result = spawnSync(
        process.execPath,
        ["--expose-gc", fileURLToPath(file), String(scopes)],
        { encoding: "utf8" },
      );
      if (result.status !== 0) throw Error(result.stderr + result.stdout);
      samples.push({ build, round, ...JSON.parse(result.stdout.trim()) });
    }
  }
}
const median = (a) => a.toSorted((a, b) => a - b)[Math.floor(a.length / 2)];
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  rounds: 9,
  order: "balanced builds; fresh serial Node process per sample",
  bundles: Object.fromEntries(
    builds.map((build) => [
      build,
      createHash("sha256")
        .update(readFileSync(new URL(`registries-${build}-minified.mjs`, root)))
        .digest("hex"),
    ]),
  ),
  medians: [1, 100, 1000].flatMap((scopes) =>
    builds.map((build) => ({
      build,
      scopes,
      writeMs: median(
        samples.filter((s) => s.build === build && s.scopes === scopes).map((s) => s.writeMs),
      ),
    })),
  ),
  samples,
};
writeFileSync(
  new URL(`${process.env.AUDIT_TAG ?? "current"}-registries-results.json`, root),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));

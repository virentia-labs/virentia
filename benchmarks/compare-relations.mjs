import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadavg } from "node:os";
import { fileURLToPath } from "node:url";

const builds = (process.env.AUDIT_BUILDS ?? "relations-before,relations-indexed").split(",");
const sizes = (process.env.AUDIT_RELATION_SIZES ?? "1000,5000,25000").split(",").map(Number);
const rounds = Number(process.env.AUDIT_ROUNDS ?? 7);
const mode = process.env.AUDIT_RELATION_MODE ?? "upsert";
const tag = process.env.AUDIT_TAG ?? "relations";
if (
  builds.length !== 2 ||
  builds.some((build) => !/^[a-z0-9-]+$/i.test(build)) ||
  !Number.isSafeInteger(rounds) ||
  rounds < 4 ||
  sizes.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 25000) ||
  !["upsert", "feed"].includes(mode) ||
  !/^[a-z0-9-]+$/i.test(tag)
)
  throw Error("Expected two builds, at least four rounds and sizes 1..25000");
const samples = [],
  hostLoad = [];
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
};
for (const n of sizes) {
  for (let round = -1; round < rounds; round++) {
    for (let position = 0; position < builds.length; position++) {
      const build = builds[(round + 1 + position) % builds.length];
      const bundle = new URL(`./.build/relations-${build}-minified.mjs`, import.meta.url);
      const result = spawnSync(
        process.execPath,
        ["--expose-gc", fileURLToPath(bundle), String(n), mode],
        {
          encoding: "utf8",
          timeout: 60000,
        },
      );
      if (result.status !== 0) throw Error(result.stderr + result.stdout);
      const sample = JSON.parse(result.stdout.trim());
      const elapsedMs = sample.elapsedMs ?? sample.upsertMs;
      if (!sample.checked || sample.n !== n || !Number.isFinite(elapsedMs))
        throw Error("Relation upsert validation failed");
      if (mode === "feed" && (sample.mode !== "feed" || sample.writes !== Math.ceil(n / 10)))
        throw Error("The baseline does not implement the requested relation-feed workload");
      if (round >= 0) samples.push({ ...sample, elapsedMs, round, build });
    }
    hostLoad.push({ n, round, load: loadavg() });
    console.log(JSON.stringify({ n, round, rounds }));
  }
}
const summary = sizes.map((n) => {
  const medians = builds.map((build) =>
    median(samples.filter((s) => s.n === n && s.build === build).map((s) => s.elapsedMs)),
  );
  const deltas = Array.from({ length: rounds }, (_, round) => {
    const pair = builds.map((build) =>
      samples.find((s) => s.n === n && s.round === round && s.build === build),
    );
    return pair[1].elapsedMs - pair[0].elapsedMs;
  });
  return {
    n,
    beforeMs: medians[0],
    afterMs: medians[1],
    ratio: medians[0] / medians[1],
    pairedDeltaMs: median(deltas),
  };
});
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  builds,
  rounds,
  sizes,
  mode,
  methodology:
    "Serial, fresh Node process per sample, one uncounted warmup pair per size, alternating build order. GC before timer; setup and complete identity/value validation outside timer. " +
    (mode === "feed"
      ? "One field-write batch with a native relation sequence subscription, not a full DOM benchmark."
      : "Supplemental children snapshot upsert, not a renderer benchmark."),
  bundles: Object.fromEntries(
    builds.map((build) => [
      build,
      createHash("sha256")
        .update(readFileSync(new URL(`./.build/relations-${build}-minified.mjs`, import.meta.url)))
        .digest("hex"),
    ]),
  ),
  summary,
  hostLoad,
  samples,
};
writeFileSync(
  new URL(`./.build/${tag}-results.json`, import.meta.url),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ summary }));

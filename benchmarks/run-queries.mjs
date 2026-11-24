import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const builds = process.env.AUDIT_BUILDS?.split(",") ?? ["current"];
const scenarios = ["sort", "sequence", "indexed-create", "indexed-write", "indexed-lookup"];
const [build, scenario] = process.argv.slice(2);
if (build) {
  const { scope, scoped, staticModel, f, sequenceBindingOf } = await import(
    new URL(`.build/library-${build}-minified.mjs`, import.meta.url)
  );
  const app = scope();
  const Row = staticModel({
    data: { rank: scenario.startsWith("indexed-") ? f.number().indexed() : f.number() },
  });
  const n = 10000;
  const inputs = Array.from({ length: n }, (_, i) => ({
    id: String(i),
    rank: scenario === "sort" ? (i * 401) % n : i,
  }));
  const creationStarted = performance.now();
  const rows = scoped(app, () => Row.create(inputs));
  let elapsedMs = performance.now() - creationStarted;
  if (scenario === "sort") {
    const query = scoped(app, () => Row.sort(Row.rank.asc));
    const started = performance.now();
    const sorted = query.toArray();
    elapsedMs = performance.now() - started;
    assert.deepEqual(
      sorted.map((row) => row.rank.value),
      Array.from({ length: n }, (_, i) => i),
    );
  } else if (scenario === "sequence") {
    const query = scoped(app, () => Row.sort(Row.rank.asc));
    const feed = sequenceBindingOf(query);
    const rendered = [...feed.snapshot()];
    const stop = feed.subscribe((edits) => {
      for (const edit of edits) {
        assert.equal(edit.type, "move");
        rendered.splice(edit.to, 0, ...rendered.splice(edit.from, edit.count));
      }
    });
    for (let i = 0; i < 4; i++) rows[0].rank.value = i % 2 ? -1 : n;
    const started = performance.now();
    for (let i = 0; i < 100; i++) rows[0].rank.value = i % 2 ? -1 : n;
    elapsedMs = performance.now() - started;
    assert.deepEqual(rendered, feed.snapshot());
    stop();
  } else if (scenario === "indexed-write") {
    for (let i = 0; i < 10; i++) rows[i].rank.value = n + i;
    const started = performance.now();
    for (let i = 0; i < 1000; i++) rows[i].rank.value = n * 2 + i;
    elapsedMs = performance.now() - started;
    for (let i = 0; i < 1000; i++)
      assert.equal(
        scoped(app, () => Row.where(Row.rank.eq(n * 2 + i)).first),
        rows[i],
      );
    assert.equal(
      scoped(app, () => Row.where(Row.rank.lt(n)).count),
      n - 1000,
    );
  } else if (scenario === "indexed-lookup") {
    const found = [];
    const started = performance.now();
    scoped(app, () => {
      for (let i = 0; i < 1000; i++) found.push(Row.where(Row.rank.eq(i * 7)).first);
    });
    elapsedMs = performance.now() - started;
    assert.deepEqual(
      found,
      Array.from({ length: 1000 }, (_, i) => rows[i * 7]),
    );
  } else {
    assert.equal(scenario, "indexed-create");
    assert.equal(
      scoped(app, () => Row.where(Row.rank.gte(0)).count),
      n,
    );
    assert.equal(
      rows.reduce((sum, row) => sum + row.rank.value, 0),
      (n * (n - 1)) / 2,
    );
  }
  console.log(JSON.stringify({ build, scenario, n, elapsedMs, checked: true }));
} else {
  const samples = [];
  for (const scenario of scenarios) {
    for (let round = 0; round < 9; round++) {
      for (let index = 0; index < builds.length; index++) {
        const build = builds[(index + round) % builds.length];
        const child = spawnSync(
          process.execPath,
          [fileURLToPath(import.meta.url), build, scenario],
          { encoding: "utf8" },
        );
        if (child.status !== 0) throw Error(child.stderr + child.stdout);
        samples.push({ round, ...JSON.parse(child.stdout) });
      }
    }
  }
  const medians = [];
  for (const scenario of scenarios)
    for (const build of builds) {
      const values = samples
        .filter((row) => row.scenario === scenario && row.build === build)
        .map((row) => row.elapsedMs)
        .sort((a, b) => a - b);
      medians.push({ scenario, build, elapsedMs: values[Math.floor(values.length / 2)] });
    }
  const report = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    rounds: 9,
    order:
      "Balanced rotation; fresh process per sample; creation outside timing except indexed-create",
    workloads: {
      sort: "First sorted snapshot of 10000 permuted model ranks",
      sequence:
        "100 moves between the first and last rank of a 10000-row query; operation consumer included",
      "indexed-create":
        "Create 10000 rows with distinct equality-indexed ranks; inputs prepared outside timing",
      "indexed-write": "Change 1000 distinct equality-indexed ranks in 10000 rows",
      "indexed-lookup": "1000 distinct single-row equality queries in 10000 rows",
    },
    bundles: Object.fromEntries(
      builds.map((build) => [
        build,
        createHash("sha256")
          .update(readFileSync(new URL(`.build/library-${build}-minified.mjs`, import.meta.url)))
          .digest("hex"),
      ]),
    ),
    medians,
    samples,
  };
  writeFileSync(
    new URL(`.build/${process.env.AUDIT_TAG ?? "current"}-query-results.json`, import.meta.url),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
}

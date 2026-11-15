import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadavg, cpus } from "node:os";

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
};
export async function compareScale({ pages, root, rounds, browserVersion }) {
  if (pages.length !== 2 || !Number.isSafeInteger(rounds) || rounds < 4)
    throw Error("A paired scaling comparison needs two builds and at least four rounds");
  const workload = await pages[0].evaluate("auditWorkload");
  if (JSON.stringify(workload) !== JSON.stringify(await pages[1].evaluate("auditWorkload")))
    throw Error("Paired workloads differ");
  const frameworks = process.env.AUDIT_SCALE_SYNC_ONLY === "1"
    ? ["virentia", "react-sync", "vue"] : ["virentia"];
  const cases = pages.flatMap(page => frameworks.map(framework => ({ page, framework })));
  const samples = [];
  const hostLoad = [{ stage: "start", load: loadavg() }];
  const filename = path.join(root, `paired-${process.env.AUDIT_TAG ?? "large"}.json`);
  for (let round = 0; round < 2; round++) {
    for (let index = 0; index < cases.length; index++) {
      const { page, framework } = cases[(round + index) % cases.length];
      await page.c("Page.bringToFront");
      await page.evaluate(`auditScaleSample('${framework}',${-1-round})`);
    }
  }
  for (let round = 0; round < rounds; round++) {
    for (let index = 0; index < cases.length; index++) {
      const { page, framework } = cases[(round + index) % cases.length];
      await page.c("Page.bringToFront");
      const sample = await page.evaluate(`auditScaleSample('${framework}',${round})`);
      if (sample.n !== workload.rows || sample.checksum !== workload.updatesPerBatch * workload.batches)
        throw Error("Paired scaling content validation failed");
      samples.push({ ...sample, build: page.variant });
    }
    writeFileSync(filename, JSON.stringify({ complete: false, workload, samples }, null, 2));
    console.log(JSON.stringify({ paired: pages.map(p => p.variant), round: round + 1, rounds }));
    hostLoad.push({ stage: `round-${round + 1}`, load: loadavg() });
  }
  const metrics = ["mountMs", "updateMs", "totalMs", "totalAndLayoutMs", "wallMs", "unmountMs", "lifecycleCommitMs"];
  for (const sample of samples) sample.lifecycleCommitMs = sample.totalMs + sample.unmountMs;
  const summary = cases.map(({ page, framework }) => {
    const rows = samples.filter(s => s.build === page.variant && s.variant === framework);
    return { build: page.variant, framework, samples: rows.length,
      ...Object.fromEntries(metrics.map(key => [key, median(rows.map(r => r[key]))])),
      ranges: Object.fromEntries(metrics.map(key => [key, [Math.min(...rows.map(r => r[key])), Math.max(...rows.map(r => r[key]))]])),
    };
  });
  const pairedDeltas = frameworks.map(framework => ({ framework,
    ...Object.fromEntries(metrics.map(key => [key, median(Array.from({ length: rounds }, (_, round) => {
      const before = samples.find(s => s.build === pages[0].variant && s.variant === framework && s.round === round);
      const after = samples.find(s => s.build === pages[1].variant && s.variant === framework && s.round === round);
      if (!before || !after) throw Error("Missing paired round");
      return after[key] - before[key];
    }))])),
  }));
  const result = { complete: true, measuredAt: new Date().toISOString(), workload, rounds,
    builds: pages.map(p => p.variant), browserVersion, frameworks,
    hostLoad, logicalCores: cpus().length,
    methodology: "Two equal full warmups. Serial samples; rotate builds/frameworks EVERY round. Fresh root per sample, unchanged auditScaleSample. Deltas are paired after-before medians, not differences of separate medians. No parallel heavy work. Raw per-batch timings and checksums retained.",
    summary, pairedDeltas, samples };
  writeFileSync(filename, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ summary, pairedDeltas }));
  return result;
}

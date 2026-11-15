import { writeFileSync } from "node:fs";
import path from "node:path";

const frameworks = process.env.AUDIT_CONTROLS === "0" ? ["virentia"]
  : process.env.AUDIT_SCALE_SYNC_ONLY === "1" ? ["virentia", "react-sync", "vue"]
  : process.env.AUDIT_SCALE_REACT_SYNC === "1"
    ? ["virentia", "react", "vue", "react-sync"] : ["virentia", "react", "vue"];
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
};

export async function scaleBrowser({ variant, root, c, evaluate, browserVersion, rounds, caseIndex }) {
  if (!Number.isSafeInteger(rounds) || rounds < 3) throw Error("Scaling needs at least 3 rounds");
  const workload = await evaluate("auditWorkload");
  if (!workload || workload.rows < 1 || workload.rows % workload.stride)
    throw Error("Invalid scaling workload");
  const warmups = Number(process.env.AUDIT_SCALE_WARMUPS ?? 2);
  if (!Number.isSafeInteger(warmups) || warmups < 1 || warmups > 20)
    throw Error("Invalid scaling warm-up count");
  console.log(JSON.stringify({ scaling: variant, workload, rounds, warmups }));
  for (let round = 0; round < warmups; round++)
    for (let index = 0; index < frameworks.length; index++) {
      const framework = frameworks[(round + index + caseIndex) % frameworks.length];
      await evaluate(`auditScaleSample('${framework}',${-1 - round})`);
      console.log(JSON.stringify({ scaling: variant, warmup: round + 1, framework }));
    }

  const heap = [];
  for (const framework of frameworks) {
    await evaluate("(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)})()");
    await c("HeapProfiler.collectGarbage");
    await c("HeapProfiler.collectGarbage");
    const before = await c("Runtime.getHeapUsage");
    const beforeDOM = await c("Memory.getDOMCounters");
    await evaluate(`(async()=>{
      const container=document.createElement('div');
      document.getElementById('host').append(container);
      const mounted=await auditMounts['${framework}'](container);
      const rows=container.querySelectorAll('tr');
      if(rows.length!==auditWorkload.rows)throw Error('Wrong live scaling row count');
      rows.forEach((row,id)=>{
        if(row.cells.length!==2||row.cells[0].textContent!==String(id)||row.cells[1].textContent!=='0')
          throw Error('Wrong live scaling content');
      });
      globalThis.auditScaleLive={container,mounted};
      container.getBoundingClientRect();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    })()`);
    await c("HeapProfiler.collectGarbage");
    const live = await c("Runtime.getHeapUsage");
    const liveDOM = await c("Memory.getDOMCounters");
    await evaluate(`(async()=>{
      const {container,mounted}=auditScaleLive;
      await mounted.dispose();
      if(container.childNodes.length)throw Error('Live scaling root leaked nodes');
      container.remove();globalThis.auditScaleLive=null;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    })()`);
    await c("HeapProfiler.collectGarbage");
    await c("HeapProfiler.collectGarbage");
    const after = await c("Runtime.getHeapUsage");
    const afterDOM = await c("Memory.getDOMCounters");
    heap.push({ framework, before, live, after, beforeDOM, liveDOM, afterDOM,
      jsLiveDelta: live.usedSize - before.usedSize,
      embedderLiveDelta: live.embedderHeapUsedSize - before.embedderHeapUsedSize,
      jsReleasedDelta: live.usedSize - after.usedSize,
      jsAfterDelta: after.usedSize - before.usedSize,
      domNodesDelta: liveDOM.nodes - beforeDOM.nodes });
  }

  if (process.env.AUDIT_SCALE_MEMORY_ONLY === "1") {
    const report = { variant, measuredAt: new Date().toISOString(), workload, warmups,
      browserVersion, heap,
      methodology: "GC-controlled live root before/after disposal, same full table and equal warmups. Memory only; no timing claim. JS and embedder heaps are not summed or labelled RSS.",
    };
    writeFileSync(path.join(root, `scale-${variant}-memory.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ scaling: variant, memoryOnly: true,
      memory: heap.map(({ framework, jsLiveDelta, jsReleasedDelta, domNodesDelta }) =>
        ({ framework, jsLiveDelta, jsReleasedDelta, domNodesDelta })) }));
    return report;
  }
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    for (let index = 0; index < frameworks.length; index++) {
      const framework = frameworks[(round + index + caseIndex) % frameworks.length];
      samples.push(await evaluate(`auditScaleSample('${framework}',${round})`));
    }
    console.log(JSON.stringify({ scaling: variant, completedRounds: round + 1, rounds }));
    writeFileSync(path.join(root, `scale-${variant}-progress.json`), JSON.stringify({
      variant, workload, completedRounds: round + 1, rounds, complete: false, samples,
    }, null, 2));
  }
  const keys = ["mountMs", "mountAndLayoutMs", "updateMs", "updateAndLayoutMs",
    "totalMs", "totalAndLayoutMs", "wallMs", "unmountMs"];
  const summary = frameworks.map(framework => {
    const selected = samples.filter(sample => sample.variant === framework);
    if (selected.length !== rounds || selected.some(sample =>
      sample.n !== workload.rows || sample.stride !== workload.stride ||
      sample.batches !== workload.batches || sample.checksum !== workload.updatesPerBatch * workload.batches))
      throw Error("Scaling sample validation failed");
    return { framework,
      ...Object.fromEntries(keys.map(key => [key, median(selected.map(sample => sample[key]))])),
      mountRange: [Math.min(...selected.map(sample => sample.mountMs)), Math.max(...selected.map(sample => sample.mountMs))],
      totalRange: [Math.min(...selected.map(sample => sample.totalMs)), Math.max(...selected.map(sample => sample.totalMs))] };
  });

  // Observed prefix medians, not a linear extrapolation from the average update.
  const prefixes = frameworks.map(framework => {
    const selected = samples.filter(sample => sample.variant === framework);
    return { framework, commit: [], withLayout: [], ...Object.fromEntries(
      [["commit", "mountMs", "batchMs"], ["withLayout", "mountAndLayoutMs", "batchAndLayoutMs"]]
        .map(([name, mount, batches]) => [name,
          Array.from({ length: workload.batches + 1 }, (_, prefix) => median(selected.map(sample =>
            sample[mount] + sample[batches].slice(0, prefix).reduce((sum, value) => sum + value, 0))))]),
    ) };
  });
  const native = prefixes[0];
  const crossover = prefixes.slice(1).map(control => ({ framework: control.framework,
    ...Object.fromEntries(["commit", "withLayout"].map(key => {
      const first = native[key].findIndex((_, prefix) => native[key].slice(prefix)
        .every((value, offset) => value <= control[key][prefix + offset]));
      return [key, first < 0 ? null : first];
    })) }));
  const environment = await evaluate(
    "({userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,viewport:{width:innerWidth,height:innerHeight},devicePixelRatio})",
  );
  const report = { variant, measuredAt: new Date().toISOString(), workload, rounds, warmups,
    methodology: {
      scenario: "Fresh full unvirtualized table per sample; 25 point-update batches separated by requestAnimationFrame; same rows and changed cells for every framework.",
      order: "Serial only; balanced framework rotation; separate page per compiled workload.",
      react: "Default React uses per-row useLayoutEffect to acknowledge concurrent commit. Optional react-sync uses flushSync with no acknowledgement hooks to separate scheduling/measurement effects from tree work; its syntax is recorded in workload.reactSyncSyntax.",
      commit: "Elapsed time to framework DOM commit, including async renderer scheduling where applicable; NOT pure CPU time. Total is the median of each sample's mount + 25 update sums, not a sum of separate medians.",
      layout: "Inclusive commit + synchronous getBoundingClientRect layout flush; not a GPU/paint measurement.",
      wall: "Whole mount + updates wall time includes intentional animation-frame waits, but excludes validation and disposal.",
      validation: "All rows and final checksum checked outside measured work; no full-table validation between updates.",
      memory: "Separate GC-controlled live-root probes, after a layout flush and two frame opportunities on attach/detach. JS and Blink/embedder deltas are reported separately, not summed or labelled process RSS.",
      crossover: "First measured update prefix after which the Virentia prefix median stays <= the competitor for all remaining measured prefixes; null means no observed crossover. No extrapolation beyond 25 updates.",
    }, summary, crossover, prefixes, heap, samples, environment, browserVersion };
  writeFileSync(path.join(root, `scale-${variant}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ scaling: variant, summary, crossover,
    memory: heap.map(({ framework, jsLiveDelta, embedderLiveDelta, domNodesDelta }) =>
      ({ framework, jsLiveDelta, embedderLiveDelta, domNodesDelta })) }));
  return report;
}

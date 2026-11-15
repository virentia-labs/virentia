// Isolate mount, updates and disposal at the configured large-table size.
// Profiler/trace runs are diagnostic evidence, never headline performance timings.
import { writeFileSync } from "node:fs";
import path from "node:path";

export async function profileScale({ variant, root, c, evaluate, browserVersion, onEvent }) {
  const workload = await evaluate("auditWorkload");
  const trials = Number(process.env.AUDIT_SCALE_PROFILE_TRIALS ?? 3);
  const allocation = process.env.AUDIT_SCALE_ALLOCATION === "1";
  const retainedHeap = process.env.AUDIT_SCALE_HEAP === "1";
  const frameworks = (process.env.AUDIT_SCALE_PROFILE_FRAMEWORKS ?? "virentia").split(",");
  const mountOnly = process.env.AUDIT_SCALE_PROFILE_MOUNT_ONLY === "1";
  if (
    frameworks.some((f) => !["virentia", "react-sync", "react", "vue"].includes(f)) ||
    new Set(frameworks).size !== frameworks.length
  )
    throw Error("Invalid profile frameworks");
  const label = process.env.AUDIT_SCALE_PROFILE_LABEL ?? "large";
  if (!/^[a-z0-9-]+$/i.test(label)) throw Error("Invalid large-profile label");
  if (
    !workload ||
    !Number.isSafeInteger(trials) ||
    trials < 0 ||
    trials > 10 ||
    (!trials && !allocation && !retainedHeap)
  )
    throw Error("Invalid large-table profiling workload");
  const report = {
    variant,
    workload,
    browserVersion,
    measuredAt: new Date().toISOString(),
    frameworks,
    phases: mountOnly ? ["mount"] : ["mount", "update", "unmount"],
    methodology:
      "Two full untimed warmups per framework; serial fresh roots; separately sampled selected phases. Retrospective UserTiming boundaries exclude instrumentation, explicit layout, validation and frame waits. CPU/trace overhead makes these diagnostic runs unsuitable for headline timings. DOM-call counters, when requested, run only after all clean CPU/allocation measurements and are not timing evidence.",
    unprofiled: [],
    heap: [],
    profiles: [],
  };
  await evaluate(`
    globalThis.auditLargeLive=null;
    globalThis.auditLargeMount=async function(framework='virentia'){
      const container=document.createElement('div');
      document.getElementById('host').append(container);
      await new Promise(requestAnimationFrame);
      const start=performance.now();
      const mounted=await auditMounts[framework](container);
      const elapsed=performance.now()-start;
      performance.mark('profile:0:start',{startTime:start});
      performance.mark('profile:0:end',{startTime:start+elapsed});
      auditLargeLive={container,mounted};
      return elapsed;
    };
    globalThis.auditLargeValidate=function(value){
      const {container}=auditLargeLive;
      const rows=container.querySelectorAll('tr');
      if(rows.length!==auditWorkload.rows)throw Error('Wrong large-profile row count');
      let sum=0;
      rows.forEach((row,id)=>{
        const expected=id%auditWorkload.stride===0?value:0;
        if(row.cells.length!==2||row.cells[0].textContent!==String(id)||row.cells[1].textContent!==String(expected))
          throw Error('Wrong large-profile content');
        sum+=Number(row.cells[1].textContent);
      });
      if(sum!==value*auditWorkload.updatesPerBatch)throw Error('Wrong large-profile checksum');
      container.getBoundingClientRect();
    };
    globalThis.auditLargeUpdate=async function(){
      const elapsed=[];
      for(let batch=1;batch<=auditWorkload.batches;batch++){
        await new Promise(requestAnimationFrame);
        const start=performance.now();
        await auditLargeLive.mounted.update(batch);
        const ms=performance.now()-start;
        performance.mark('profile:'+batch+':start',{startTime:start});
        performance.mark('profile:'+batch+':end',{startTime:start+ms});
        elapsed.push(ms);
        auditLargeLive.container.getBoundingClientRect();
      }
      return elapsed;
    };
    globalThis.auditLargeUnmount=async function(){
      const start=performance.now();
      await auditLargeLive.mounted.dispose();
      const elapsed=performance.now()-start;
      performance.mark('profile:0:start',{startTime:start});
      performance.mark('profile:0:end',{startTime:start+elapsed});
      return elapsed;
    };
    globalThis.auditLargeRelease=function(){
      if(auditLargeLive.container.childNodes.length)throw Error('Large-profile disposal leaked DOM');
      auditLargeLive.container.remove();
      auditLargeLive=null;
      if(document.getElementById('host').childNodes.length)throw Error('Large-profile leaked root');
    };
  `);
  for (let round = 0; round < 2; round++)
    for (let index = 0; index < frameworks.length; index++)
      await evaluate(
        `auditScaleSample('${frameworks[(round + index) % frameworks.length]}',${-1 - round})`,
      );
  async function collectDOMCounts() {
    report.domCounts = [];
    await evaluate(`
      globalThis.auditDOMCalls=Object.create(null);
      globalThis.auditDOMRestores=[];
      for(const [proto,key] of [[Document.prototype,'createElement'],[Document.prototype,'createElementNS'],
        [Document.prototype,'createTextNode'],[Document.prototype,'createDocumentFragment'],
        [Node.prototype,'appendChild'],[Node.prototype,'insertBefore'],[Element.prototype,'setAttribute']]){
        const original=proto[key];
        proto[key]=function(...args){auditDOMCalls[key]=(auditDOMCalls[key]||0)+1;return original.apply(this,args)};
        auditDOMRestores.push(()=>proto[key]=original);
      }
      const text=Object.getOwnPropertyDescriptor(Node.prototype,'textContent');
      Object.defineProperty(Node.prototype,'textContent',{...text,set(value){
        auditDOMCalls.textContent=(auditDOMCalls.textContent||0)+1;
        return text.set.call(this,value);
      }});
      auditDOMRestores.push(()=>Object.defineProperty(Node.prototype,'textContent',text));
    `);
    for (const framework of frameworks) {
      await evaluate("globalThis.auditDOMCalls=Object.create(null)");
      await evaluate(`auditLargeMount('${framework}')`);
      report.domCounts.push({
        framework,
        counts: await evaluate("auditDOMCalls"),
        scope:
          "Mount plus one diagnostic container, before validation or disposal; not timed evidence",
      });
      await evaluate("auditLargeValidate(0); auditLargeUnmount().then(auditLargeRelease)");
    }
    await evaluate(
      "for(const restore of auditDOMRestores)restore();delete globalThis.auditDOMRestores;delete globalThis.auditDOMCalls",
    );
  }
  await c("Profiler.enable");
  await c("Profiler.setSamplingInterval", { interval: 100 });
  for (let trial = 0; trial < trials; trial++) {
    for (let index = 0; index < frameworks.length; index++) {
      const framework = frameworks[(trial + index) % frameworks.length];
      await c("HeapProfiler.collectGarbage");
      for (const phase of mountOnly ? ["mount"] : ["mount", "update", "unmount"]) {
        await evaluate("performance.clearMarks()");
        const events = [];
        let finish;
        const done = new Promise((resolve) => {
          finish = resolve;
        });
        const off = onEvent((event) => {
          if (event.method === "Tracing.dataCollected") events.push(...event.params.value);
          if (event.method === "Tracing.tracingComplete") finish();
        });
        await c("Tracing.start", {
          categories: "devtools.timeline,v8,blink.user_timing,disabled-by-default-v8.gc",
          transferMode: "ReportEvents",
        });
        await c("Profiler.start");
        const expression = {
          mount: `auditLargeMount('${framework}')`,
          update: "auditLargeUpdate()",
          unmount: "auditLargeUnmount()",
        }[phase];
        const elapsed = await evaluate(expression);
        const { profile } = await c("Profiler.stop");
        await c("Tracing.end");
        await done;
        off();
        const prefix = path.join(
          root,
          `render-${variant}-${label}-${frameworks.length > 1 ? framework + "-" : ""}${trial}-${phase}`,
        );
        writeFileSync(`${prefix}.cpuprofile`, JSON.stringify(profile));
        writeFileSync(`${prefix}.trace.json`, JSON.stringify({ traceEvents: events }));
        report.profiles.push({
          framework,
          phase,
          trial,
          elapsed,
          cpu: `${prefix}.cpuprofile`,
          trace: `${prefix}.trace.json`,
        });
        if (phase === "mount") await evaluate("auditLargeValidate(0)");
        if (phase === "update") await evaluate("auditLargeValidate(auditWorkload.batches)");
        if (phase === "unmount") await evaluate("auditLargeRelease()");
        console.log(JSON.stringify({ variant, framework, trial, phase, elapsed }));
        writeFileSync(
          path.join(root, `render-${variant}-${label}-report.json`),
          JSON.stringify(report, null, 2),
        );
      }
      if (mountOnly) await evaluate("auditLargeUnmount().then(auditLargeRelease)");
    }
  }
  if (retainedHeap) {
    // Separate from CPU/timing trials. Full GC at each boundary measures live
    // JS heap; DOM counters are reported independently of those bytes.
    for (let round = 0; round < 3; round++) for (let index = 0; index < frameworks.length; index++) {
      const framework = frameworks[(round + index) % frameworks.length];
      await c("HeapProfiler.collectGarbage");
      const before = await c("Runtime.getHeapUsage"), beforeDOM = await c("Memory.getDOMCounters");
      await evaluate(`auditLargeMount('${framework}')`);
      await evaluate("auditLargeValidate(0)");
      await c("HeapProfiler.collectGarbage");
      const mounted = await c("Runtime.getHeapUsage"), mountedDOM = await c("Memory.getDOMCounters");
      await evaluate("auditLargeUnmount().then(auditLargeRelease)");
      await c("HeapProfiler.collectGarbage");
      const released = await c("Runtime.getHeapUsage"), releasedDOM = await c("Memory.getDOMCounters");
      report.heap.push({ round, framework, before, mounted, released,
        mountedBytes: mounted.usedSize - before.usedSize, retainedBytes: released.usedSize - before.usedSize,
        dom: { before: beforeDOM, mounted: mountedDOM, released: releasedDOM } });
    }
    writeFileSync(path.join(root, `render-${variant}-${label}-report.json`), JSON.stringify(report, null, 2));
  }
  if (allocation) {
    const interval = 8192;
    for (const framework of frameworks) {
      await c("HeapProfiler.collectGarbage");
      await c("HeapProfiler.startSampling", {
        samplingInterval: interval,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      await evaluate(`auditLargeMount('${framework}')`);
      const { profile } = await c("HeapProfiler.stopSampling");
      writeFileSync(
        path.join(root, `render-${variant}-${label}-${framework}.heapprofile`),
        JSON.stringify(profile),
      );
      report.allocationSampling = {
        interval,
        mounts: 1,
        includesCollectedObjects: true,
        frameworks,
      };
      await evaluate("auditLargeValidate(0)");
      await evaluate("auditLargeUnmount()");
      await evaluate("auditLargeRelease()");
      writeFileSync(
        path.join(root, `render-${variant}-${label}-report.json`),
        JSON.stringify(report, null, 2),
      );
    }
  }
  if (process.env.AUDIT_SCALE_PROFILE_COUNTS === "1") {
    await collectDOMCounts();
    writeFileSync(
      path.join(root, `render-${variant}-${label}-report.json`),
      JSON.stringify(report, null, 2),
    );
  }
  return report;
}

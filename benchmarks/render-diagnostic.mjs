// Diagnostic-only build overlay and CDP measurements. The public workload and
// its default runner are unchanged; no timers/probes enter production sources.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export function renderDiagnosticOverlay({ counts = false } = {}) {
  return {
    name: "render-diagnostic",
    setup(build) {
      build.onLoad({ filter: /(?:ui\.harness|packages\/(?:core|ui)\/lib\/.*)\.ts$/ }, (args) => {
        let contents = readFileSync(args.path, "utf8");
        if (args.path.endsWith("ui.harness.ts")) {
          contents = contents.replace("render as vrender,", "render as vrender, hydrate as vhydrate,");
          // Outside the original timers: delimit the original mount operation
          // without including its 25 later updates, validation or disposal.
          contents = contents.replace(
            "const mountMs = performance.now() - start;",
            "const mountMs = performance.now() - start;\n  performance.mark('profile:'+round+':start',{startTime:start});\n  performance.mark('profile:'+round+':end',{startTime:start+mountMs});",
          );
          contents += `\nObject.assign(globalThis, {
            auditMounts: {virentia:mountVirentia,react:mountReact,vue:mountVue},
            auditCounts: ${counts},
            async auditRetentionStart(mode){
              const app=scope();
              const Model=staticModel({data:{count:f.number(0)}});
              const instance=scoped(app,()=>Model.create({id:'retained'}));
              const View=component({model:Model,keep:true,view:(_props,self)=>vh('p',null,self.model.count)});
              const ownerDocument=mode==='document'?document.implementation.createHTMLDocument('retention'):document;
              const container=ownerDocument.createElement('div');
              (mode==='document'?ownerDocument.body:document.getElementById('host')).append(container);
              const hydrating=mode==='hydrate'||mode==='mismatch';
              if(hydrating)container.innerHTML='<p><!--ui--><!--ui:t-->'+(mode==='mismatch'?'server':'0')+'<!--/ui--></p>';
              const tree=()=>mode==='native-ancestor'
                ?vh('select',{value:'row'},vh('option',{value:'row'},vh(View,{model:instance})))
                :mode==='document'?vh('main',null,vh('section',null,vh(View,{model:instance})))
                :vh(View,{model:instance});
              let detach,failed=false;
              try{detach=(hydrating?vhydrate:vrender)(tree,container,{scope:app});}
              catch(error){if(mode!=='mismatch'||!String(error).includes('Hydration mismatch'))throw error;failed=true;}
              if((mode==='mismatch')!==failed)throw Error('Wrong hydration outcome');
              const paragraph=container.querySelector('p');
              if(!paragraph)throw Error('Missing retention fixture DOM');
              const text=Array.from(paragraph.childNodes).find(node=>node.nodeType===3);
              const targets=[container,paragraph,text];
              if(mode==='document')targets.push(ownerDocument);
              if(mode==='native-ancestor')targets.push(container.querySelector('select'));
              globalThis.auditRetentionRefs=targets.map(value=>new WeakRef(value));
              globalThis.auditRetentionLive={app,Model,View,instance};
              if(detach)await detach();
              if(!instance.alive)throw Error('Supplied model was disposed');
              if(mode==='mismatch'&&paragraph.textContent!=='server')throw Error('Failed hydration changed server DOM');
              container.remove();
              return {mode,modelAlive:instance.alive,weakTargets:auditRetentionRefs.length};
            },
            auditRetentionStatus(){return {remaining:auditRetentionRefs.filter(ref=>ref.deref()!==undefined).length,modelAlive:auditRetentionLive.instance.alive}},
            async auditRetentionRelease(){await auditRetentionLive.instance.dispose();globalThis.auditRetentionLive=globalThis.auditRetentionRefs=null},
          });\n`;
        } else if (counts) {
          if (args.path.endsWith("/graph/deps.ts")) {
            contents = contents.replace(
              "current.dependencies ??= emptyReadDependencies as Set<Node>;",
              `current.dependencies ??= emptyReadDependencies as Set<Node>;globalThis.__renderCounts[current.dependencies.size?'capture.nonempty':'capture.empty']=(globalThis.__renderCounts[current.dependencies.size?'capture.nonempty':'capture.empty']||0)+1;`,
            ).replace(
              "return { value, dependencies: readDependencies ?? emptyReadDependencies };",
              `const dependencies=readDependencies??emptyReadDependencies;globalThis.__renderCounts[dependencies.size?'capture.nonempty':'capture.empty']=(globalThis.__renderCounts[dependencies.size?'capture.nonempty':'capture.empty']||0)+1;return { value, dependencies };`,
            );
          }
          const file = ts.createSourceFile(args.path, contents, ts.ScriptTarget.Latest, true);
          const edits = [];
          function visit(node) {
            if (ts.isFunctionLike(node) && node.body && ts.isBlock(node.body)) {
              const name = node.name?.getText(file) ??
                (ts.isConstructorDeclaration(node) ? `${node.parent.name?.text ?? "anonymous"}.constructor` :
                node.parent.name?.getText(file) ?? "anonymous");
              const label = `${args.path.split("/packages/")[1]}:${name}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
              edits.push({ pos: node.body.getStart(file) + 1, value:
                `globalThis.__renderCounts[${JSON.stringify(label)}]=(globalThis.__renderCounts[${JSON.stringify(label)}]||0)+1;` });
            }
            ts.forEachChild(node, visit);
          }
          visit(file);
          for (const edit of edits.sort((a, b) => b.pos - a.pos))
            contents = contents.slice(0, edit.pos) + edit.value + contents.slice(edit.pos);
          // Units are also declared during module loading, before the test begins.
          contents = `globalThis.__renderCounts ??= Object.create(null);\n` + contents;
        }
        return { contents, loader: "ts" };
      });
    },
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[sorted.length >> 1]
    : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2;
};

export async function renderDiagnostic({ variant, root, c, evaluate, browserVersion, onEvent, caseIndex }) {
  const coldOnly = process.env.AUDIT_RENDER_COLD_ONLY === "1";
  const label = process.env.AUDIT_RENDER_LABEL;
  if (label && !/^[a-z0-9-]+$/i.test(label)) throw Error("Invalid diagnostic label");
  const prefix = path.join(root, `render-${variant}${coldOnly ? `-cold-${caseIndex}` : label ? `-${label}` : ""}`);
  const report = {
    variant, measuredAt: new Date().toISOString(), browserVersion,
    workload: { rows: 1000, elements: 3002, textNodes: 2000, reactiveCells: 1000 },
    methodology: "Serial samples, one page/build, unchanged original model+DOM workload; timers exclude validation, unmount and frame wait. CPU/GC traces are supplemental, not headline timings.",
    boundaries: "UserTiming marks are emitted retrospectively, outside timers, with startTime equal to the original performance.now boundaries. This excludes profiler sampling of mark() itself from short mount/update intervals.",
    unprofiled: [], profiles: [], heap: [],
  };
  await evaluate(`globalThis.auditDiagnosticLive=null;
    globalThis.auditDiagnosticMount=async function(framework,label){
      const container=document.createElement('div');
      document.getElementById('host').append(container);
      await new Promise(requestAnimationFrame);
      const started=performance.now();
      const result=auditMounts[framework](container);
      const mounted=result && typeof result.then==='function'?await result:result;
      const mountMs=performance.now()-started;
      performance.mark(label+':start',{startTime:started});
      performance.mark(label+':end',{startTime:started+mountMs});
      auditDiagnosticLive={mounted,container};
      return {framework,mountMs};
    };
    globalThis.auditDiagnosticDispose=async function(){
      const {mounted,container}=auditDiagnosticLive;
      const rows=container.querySelectorAll('tr');
      if(rows.length!==1000)throw Error('Wrong row count');
      rows.forEach((row,id)=>{
        if(row.cells.length!==2||row.cells[0].textContent!==String(id)||row.cells[1].textContent!=='0')
          throw Error('Wrong cell content');
      });
      await mounted.dispose();
      if(container.childNodes.length)throw Error('Unmount leaked nodes');
      container.remove();auditDiagnosticLive=null;
    };`);

  if (process.env.AUDIT_RENDER_RETENTION === "1") {
    report.retention = [];
    for (const mode of ["render", "hydrate", "mismatch", "document", "native-ancestor"]) {
      const sample = await evaluate(`auditRetentionStart('${mode}')`);
      let status;
      for (let attempt = 0; attempt < 8; attempt++) {
        await c("HeapProfiler.collectGarbage");
        status = await evaluate("auditRetentionStatus()");
        if (!status.remaining) break;
      }
      report.retention.push({ ...sample, ...status });
      await evaluate("auditRetentionRelease()");
    }
    writeFileSync(`${prefix}-retention.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ variant, retention: report.retention }));
    return report;
  }

  if (await evaluate("auditCounts")) {
    await evaluate(`globalThis.__renderCounts=Object.create(null);
      globalThis.__domCounts=Object.create(null);
      globalThis.__domRestores=[];
      for(const [proto,key] of [[Document.prototype,'createElement'],[Document.prototype,'createElementNS'],
        [Document.prototype,'createTextNode'],[Document.prototype,'createDocumentFragment'],
        [Node.prototype,'appendChild'],[Node.prototype,'insertBefore'],[Element.prototype,'setAttribute']]){
        const original=proto[key];
        proto[key]=function(...args){__domCounts[key]=(__domCounts[key]||0)+1;return original.apply(this,args)};
        __domRestores.push(()=>proto[key]=original);
      }`);
    await evaluate(`auditDiagnosticMount('virentia','count')`);
    report.counts = await evaluate(`({functions:__renderCounts,dom:__domCounts})`);
    await evaluate(`globalThis.__renderCounts=Object.create(null);globalThis.__domCounts=Object.create(null);auditDiagnosticLive.mounted.update(1)`);
    report.updateCounts = await evaluate(`({functions:__renderCounts,dom:__domCounts})`);
    await evaluate("auditDiagnosticLive.mounted.update(0)");
    await evaluate(`for(const restore of __domRestores)restore();`);
    await evaluate("auditDiagnosticDispose()");
    writeFileSync(`${prefix}-counts.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ variant, countsFile: `${prefix}-counts.json` }));
    return report;
  }

  if (coldOnly) {
    const events = [];
    let finish;
    const done = new Promise((resolve) => finish = resolve);
    const off = onEvent((event) => {
      if (event.method === "Tracing.dataCollected") events.push(...event.params.value);
      if (event.method === "Tracing.tracingComplete") finish();
    });
    await c("Profiler.enable");
    await c("Profiler.setSamplingInterval", { interval: 100 });
    await c("Tracing.start", { categories: "devtools.timeline,v8,blink.user_timing,disabled-by-default-v8.gc", transferMode: "ReportEvents" });
    await c("Profiler.start");
    const sample = await evaluate(`auditDiagnosticMount('virentia','profile:0')`);
    const { profile } = await c("Profiler.stop");
    await c("Tracing.end");
    await done;
    off();
    const name = `${prefix}-virentia`;
    writeFileSync(`${name}.cpuprofile`, JSON.stringify(profile));
    writeFileSync(`${name}.trace.json`, JSON.stringify({ traceEvents: events }));
    report.profiles.push({ framework: "virentia", phase: "cold-mount", trial: caseIndex,
      mounts: 1, samples: [sample], cpu: `${name}.cpuprofile`, trace: `${name}.trace.json` });
    await evaluate("auditDiagnosticDispose()");
    writeFileSync(`${prefix}-report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ variant, coldMount: sample.mountMs, report: `${prefix}-report.json` }));
    return report;
  }

  if (process.env.AUDIT_RENDER_FULL_SUITE === "1") {
    const frameworks = ["virentia", "react", "vue"];
    for (const framework of frameworks) await evaluate(`auditSample('${framework}',-1)`);
    const rounds = Number(process.env.AUDIT_RENDER_ROUNDS ?? 12);
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < frameworks.length; i++) {
        const framework = frameworks[(i + round) % frameworks.length];
        report.unprofiled.push(await evaluate(`auditSample('${framework}',${round})`));
      }
    }
    for (const framework of frameworks) console.log(JSON.stringify({ variant, originalSuite: framework,
      mountMs: median(report.unprofiled.filter((s) => s.variant === framework).map((s) => s.mountMs)),
      updateMs: median(report.unprofiled.filter((s) => s.variant === framework).map((s) => s.updateMs)),
    }));
    await c("Profiler.enable");
    await c("Profiler.setSamplingInterval", { interval: 100 });
    const trials = Number(process.env.AUDIT_RENDER_TRIALS ?? 3);
    const count = Number(process.env.AUDIT_RENDER_MOUNTS ?? 12);
    for (let trial = 0; trial < trials; trial++) {
      const events = [];
      let finish;
      const done = new Promise((resolve) => finish = resolve);
      const off = onEvent((event) => {
        if (event.method === "Tracing.dataCollected") events.push(...event.params.value);
        if (event.method === "Tracing.tracingComplete") finish();
      });
      await c("Tracing.start", { categories: "devtools.timeline,v8,blink.user_timing,disabled-by-default-v8.gc", transferMode: "ReportEvents" });
      await c("Profiler.start");
      const samples = [];
      for (let round = 0; round < count; round++) samples.push(await evaluate(`auditSample('virentia',${round})`));
      const { profile } = await c("Profiler.stop");
      await c("Tracing.end");
      await done;
      off();
      const name = `${prefix}-virentia-original-${trial}`;
      writeFileSync(`${name}.cpuprofile`, JSON.stringify(profile));
      writeFileSync(`${name}.trace.json`, JSON.stringify({ traceEvents: events }));
      report.profiles.push({ framework: "virentia", phase: "original-suite-mount", trial,
        mounts: count, samples, cpu: `${name}.cpuprofile`, trace: `${name}.trace.json` });
      writeFileSync(`${prefix}-report.json`, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ variant, originalSuiteTrial: trial, mounts: count,
        profiledMedianMs: median(samples.map((s) => s.mountMs)) }));
    }
    report.methodology = "Original auditSample, same 1000 rows / 25 frame-separated update batches / validation / disposal; balanced unprofiled framework order. UserTiming marks are outside original mount timers. Only mount marks analyzed in the full CPU/GC trace.";
    writeFileSync(`${prefix}-report.json`, JSON.stringify(report, null, 2));
    return report;
  }

  // Record first attachment in this freshly loaded page, before any warmup.
  report.cold = await evaluate(`auditDiagnosticMount('virentia','cold')`);
  await evaluate("auditDiagnosticDispose()");
  for (const framework of ["virentia", "react", "vue"])
    await evaluate(`auditSample('${framework}',-1)`);
  const rounds = Number(process.env.AUDIT_RENDER_ROUNDS ?? 24);
  const frameworks = ["virentia", "react", "vue"];
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < frameworks.length; i++) {
      const framework = frameworks[(i + round) % frameworks.length];
      report.unprofiled.push({ round, ...await evaluate(`auditDiagnosticMount('${framework}','timed')`) });
      await evaluate("auditDiagnosticDispose()");
    }
  }
  for (const framework of frameworks) {
    await c("HeapProfiler.collectGarbage");
    const before = await c("Runtime.getHeapUsage");
    await evaluate(`auditDiagnosticMount('${framework}','heap')`);
    await c("HeapProfiler.collectGarbage");
    const live = await c("Runtime.getHeapUsage");
    await evaluate("auditDiagnosticDispose()");
    await c("HeapProfiler.collectGarbage");
    const after = await c("Runtime.getHeapUsage");
    report.heap.push({ framework, before, live, after,
      liveDelta: live.usedSize - before.usedSize, releasedDelta: after.usedSize - before.usedSize });
  }

  const trials = Number(process.env.AUDIT_RENDER_TRIALS ?? 3);
  const mounts = Number(process.env.AUDIT_RENDER_MOUNTS ?? 60);
  await c("Profiler.enable");
  await c("Profiler.setSamplingInterval", { interval: 100 });
  for (let trial = 0; trial < trials; trial++) {
    for (let i = 0; i < frameworks.length; i++) {
      const framework = frameworks[(i + trial) % frameworks.length];
      const events = [];
      let tracingDone;
      const done = new Promise((resolve) => tracingDone = resolve);
      const off = onEvent((event) => {
        if (event.method === "Tracing.dataCollected") events.push(...event.params.value);
        if (event.method === "Tracing.tracingComplete") tracingDone();
      });
      await c("HeapProfiler.collectGarbage");
      await c("Tracing.start", { categories: "devtools.timeline,v8,blink.user_timing,disabled-by-default-v8.gc", transferMode: "ReportEvents" });
      await c("Profiler.start");
      const samples = await evaluate(`(async()=>{const results=[];
        for(let i=0;i<${mounts};i++){
          results.push(await auditDiagnosticMount('${framework}','profile:'+i));
          await auditDiagnosticDispose();
        }return results})()`);
      const { profile } = await c("Profiler.stop");
      await c("Tracing.end");
      await done;
      off();
      const name = `${prefix}-${framework}-${trial}`;
      writeFileSync(`${name}.cpuprofile`, JSON.stringify(profile));
      writeFileSync(`${name}.trace.json`, JSON.stringify({ traceEvents: events }));
      report.profiles.push({ framework, trial, mounts, samples, cpu: `${name}.cpuprofile`, trace: `${name}.trace.json` });
      console.log(JSON.stringify({ variant, framework, trial, mounts,
        unprofiledMedianMs: median(report.unprofiled.filter((s) => s.framework === framework).map((s) => s.mountMs)),
        profiledMedianMs: median(samples.map((s) => s.mountMs)) }));
      writeFileSync(`${prefix}-report.json`, JSON.stringify(report, null, 2));
    }
  }

  if (process.env.AUDIT_RENDER_UPDATES === "1") {
    const framework = "virentia", count = 300;
    await evaluate(`auditDiagnosticMount('${framework}','update-setup')`);
    await evaluate("auditDiagnosticLive.mounted.update(1)");
    const events = [];
    let finish;
    const done = new Promise((resolve) => finish = resolve);
    const off = onEvent((event) => {
      if (event.method === "Tracing.dataCollected") events.push(...event.params.value);
      if (event.method === "Tracing.tracingComplete") finish();
    });
    await c("Tracing.start", { categories: "devtools.timeline,v8,blink.user_timing,disabled-by-default-v8.gc", transferMode: "ReportEvents" });
    await c("Profiler.start");
    const samples = await evaluate(`(async()=>{const results=[];
      for(let i=0;i<${count};i++){
        await new Promise(requestAnimationFrame);
        const start=performance.now();
        await auditDiagnosticLive.mounted.update(i+2);
        const elapsed=performance.now()-start;
        results.push({updateMs:elapsed});
        performance.mark('profile:'+i+':start',{startTime:start});
        performance.mark('profile:'+i+':end',{startTime:start+elapsed});
      }
      const rows=auditDiagnosticLive.container.querySelectorAll('tr');
      if(rows.length!==1000||Array.from(rows).some((r,i)=>r.cells[1].textContent!==String(i%10===0?${count}+1:0)))
        throw Error('Wrong update result');
      return results})()`);
    const { profile } = await c("Profiler.stop");
    await c("Tracing.end");
    await done;
    off();
    const name = `${prefix}-virentia-updates`;
    writeFileSync(`${name}.cpuprofile`, JSON.stringify(profile));
    writeFileSync(`${name}.trace.json`, JSON.stringify({ traceEvents: events }));
    report.profiles.push({ framework, phase: "update-100-cells", trial: 0, mounts: count,
      samples, cpu: `${name}.cpuprofile`, trace: `${name}.trace.json` });
    await evaluate("auditDiagnosticLive.mounted.update(0)");
    await evaluate("auditDiagnosticDispose()");
    console.log(JSON.stringify({ variant, updates: count, medianUpdateMs: median(samples.map((s) => s.updateMs)) }));
  }

  // Allocation sampling is a separate workload: never mix its overhead into CPU/timer results.
  if (process.env.AUDIT_RENDER_ALLOCATIONS !== "0") {
    const interval = Number(process.env.AUDIT_RENDER_ALLOC_INTERVAL ?? 8192);
    const count = Number(process.env.AUDIT_RENDER_ALLOC_MOUNTS ?? 20);
    if (!Number.isSafeInteger(interval) || interval < 128 ||
        !Number.isSafeInteger(count) || count < 1 || count > 1000)
      throw Error("Invalid allocation sampling configuration");
    report.allocationSampling = { interval, mounts: count };
    for (const framework of frameworks) {
      await c("HeapProfiler.collectGarbage");
      await c("HeapProfiler.startSampling", { samplingInterval: interval,
        includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      for (let i = 0; i < count; i++) {
        await evaluate(`auditDiagnosticMount('${framework}','alloc')`);
        await evaluate("auditDiagnosticDispose()");
      }
      const { profile } = await c("HeapProfiler.stopSampling");
      writeFileSync(`${prefix}-${framework}.heapprofile`, JSON.stringify(profile));
    }
  }
  writeFileSync(`${prefix}-report.json`, JSON.stringify(report, null, 2));
  return report;
}

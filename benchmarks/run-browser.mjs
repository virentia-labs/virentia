import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), ".build");
mkdirSync(root, { recursive: true });
const lockPath = path.join(root, "browser-benchmark.lock");
let lock;
try {
  lock = openSync(lockPath, "wx");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  const owner = Number(readFileSync(lockPath, "utf8"));
  if (!Number.isSafeInteger(owner) || owner < 1)
    throw new Error(`Invalid benchmark lock: ${lockPath}`);
  try {
    process.kill(owner, 0);
    throw new Error(
      `Browser benchmark PID ${owner} is still running; concurrent sampling is forbidden`,
    );
  } catch (check) {
    if (check.code !== "ESRCH") throw check;
  }
  unlinkSync(lockPath);
  lock = openSync(lockPath, "wx");
}
writeFileSync(lock, String(process.pid));
closeSync(lock);
let benchmarkChrome;
process.once("exit", () => {
  benchmarkChrome?.kill();
  try {
    if (readFileSync(lockPath, "utf8") === String(process.pid)) unlinkSync(lockPath);
  } catch {
    /* Preserve the benchmark's original result/error. */
  }
});
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));
const suffix = process.argv.includes("minified") ? "-minified" : "";
const server = createServer((req, res) => {
  if (req.url.startsWith("/ui-")) {
    res.setHeader("content-type", "text/javascript");
    res.end(readFileSync(path.join(root, req.url.slice(1))));
    return;
  }
  const variant = new URL(req.url, "http://local").searchParams.get("variant") ?? "original";
  res.setHeader("content-type", "text/html");
  res.end(
    `<!DOCTYPE html><html><head><style>body{font:16px system-ui;margin:24px}#host{height:400px;overflow:auto;contain:strict}table{border-collapse:collapse}td{width:120px;height:24px}</style></head><body><button>Run</button><p id="status"></p><div id="host"></div><pre id="results"></pre><script type="module" src="/ui-${variant}${suffix}.mjs"></script></body></html>`,
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const profileDirectory = mkdtempSync(path.join(tmpdir(), "virentia-audit-chrome-"));
const chrome = spawn(
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--window-size=1280,900",
    `--user-data-dir=${profileDirectory}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
benchmarkChrome = chrome;
let diagnostics = "";
const endpoint = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    server.close();
    chrome.kill();
    reject(Error("Chrome startup timed out: " + diagnostics));
  }, 15000);
  chrome.stderr.on("data", (c) => {
    diagnostics += c;
    const match = diagnostics.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) {
      clearTimeout(timeout);
      resolve(match[1]);
    }
  });
  chrome.once("error", (error) => {
    clearTimeout(timeout);
    server.close();
    rmSync(profileDirectory, { recursive: true, force: true });
    reject(error);
  });
  chrome.once("exit", (code) => {
    clearTimeout(timeout);
    reject(Error("Chrome exited " + code + " " + diagnostics));
  });
});
const ws = new WebSocket(endpoint);
await once(ws, "open");
let nextId = 0;
const pending = new Map();
const diagnosticListeners = new Set();
const rejectPending = (error) => {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
};
ws.addEventListener("close", () => rejectPending(Error("Benchmark CDP socket closed")));
ws.addEventListener("error", () => rejectPending(Error("Benchmark CDP socket failed")));
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (!m.id) for (const listener of diagnosticListeners) listener(m);
  if (m.id) {
    const waiter = pending.get(m.id);
    if (waiter) {
      pending.delete(m.id);
      m.error ? waiter.reject(Error(JSON.stringify(m.error))) : waiter.resolve(m.result);
    }
  }
});
const call = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(Error(`CDP closed before ${method}`)); return; }
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(Error(`Benchmark CDP timeout: ${method}`));
    }, 60000);
    pending.set(id, {
      resolve(value) { clearTimeout(timeout); resolve(value); },
      reject(error) { clearTimeout(timeout); reject(error); },
    });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
const reports = [];
const pages = [];
const frameworks = process.env.AUDIT_CONTROLS !== "0" ? ["virentia", "react", "vue"] : ["virentia"];
const rounds = Number(process.env.AUDIT_ROUNDS ?? 9);
const extraWarmupRounds = Number(process.env.AUDIT_EXTRA_WARMUP_ROUNDS ?? 0);
if (!Number.isInteger(extraWarmupRounds) || extraWarmupRounds < 0 || extraWarmupRounds > 100)
  throw new Error("AUDIT_EXTRA_WARMUP_ROUNDS must be an integer from 0 to 100");
const browserVersion = await call("Browser.getVersion");
try {
  for (const variant of process.env.AUDIT_VARIANTS?.split(",") ?? ["current"]) {
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    const c = (method, params = {}) => call(method, params, sessionId);
    const evaluate = async (expression) => {
      const result = await c("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await c("Page.enable");
    await c("Page.bringToFront");
    await c("Page.navigate", { url: `${base}/?variant=${variant}` });
    for (let i = 0; i < 200; i++) {
      if (await evaluate('typeof auditMount==="function"')) break;
      await new Promise((r) => setTimeout(r, 25));
      if (i === 199) throw Error("Page did not initialize");
    }
    if (process.env.AUDIT_SCALE_COMPARE === "1") {
      pages.push({ variant, targetId, c, evaluate });
      continue;
    }
    if (process.env.AUDIT_SCALE_PROFILE === "1") {
      const { profileScale } = await import("./profile-scale.mjs");
      reports.push(await profileScale({
        variant, root, c, evaluate, browserVersion,
        onEvent(listener) {
          diagnosticListeners.add(listener);
          return () => diagnosticListeners.delete(listener);
        },
      }));
      await call("Target.closeTarget", { targetId });
      continue;
    }
    if (process.env.AUDIT_RENDER_DIAGNOSTIC === "1") {
      const { renderDiagnostic } = await import("./render-diagnostic.mjs");
      reports.push(await renderDiagnostic({
        variant, root, c, evaluate, browserVersion, caseIndex: reports.length,
        onEvent(listener) {
          diagnosticListeners.add(listener);
          return () => diagnosticListeners.delete(listener);
        },
      }));
      await call("Target.closeTarget", { targetId });
      continue;
    }
    if (process.env.AUDIT_SCALE === "1") {
      const { scaleBrowser } = await import("./scale-browser.mjs");
      reports.push(await scaleBrowser({ variant, root, c, evaluate, browserVersion,
        rounds, caseIndex: reports.length }));
      await call("Target.closeTarget", { targetId });
      continue;
    }
    await evaluate('auditSample("virentia",-1)');
    if (process.env.AUDIT_DOM_PROBE === "1") {
      const samples = [];
      for (let round = 0; round < 8; round++)
        for (let index = 0; index < 2; index++) {
          const clone = (index + round) % 2 === 0;
          await c("HeapProfiler.collectGarbage");
          samples.push(
            await evaluate(
              `(()=>{const clone=${clone};const template=document.createElement('td');const nodes=[];const started=performance.now();for(let i=0;i<50000;i++)nodes.push(clone?template.cloneNode(false):document.createElement('td'));const elapsed=performance.now()-started;if(nodes.length!==50000||nodes.some(n=>n.localName!=='td'))throw Error('DOM probe failed');return{clone,elapsed};})()`,
            ),
          );
        }
      console.log(JSON.stringify({ variant, domProbe: samples }));
    }
    if (process.env.AUDIT_DOM_PROBE === "text") {
      const samples = [];
      for (let round = 0; round < 8; round++)
        for (let index = 0; index < 2; index++) {
          const content = (index + round) % 2 === 0;
          await c("HeapProfiler.collectGarbage");
          samples.push(
            await evaluate(
              `(()=>{const content=${content};const nodes=[];const started=performance.now();for(let i=0;i<30000;i++){const el=document.createElement('td');let text;if(content){el.textContent='value';text=el.firstChild;}else{text=document.createTextNode('value');el.appendChild(text);}nodes.push(el,text);}const elapsed=performance.now()-started;if(nodes.length!==60000||nodes[1].data!=='value')throw Error('DOM text probe failed');return{content,elapsed};})()`,
            ),
          );
        }
      console.log(JSON.stringify({ variant, domTextProbe: samples }));
    }
    if (process.env.AUDIT_DOM_PROBE === "tree") {
      const samples = [];
      for (let round = 0; round < 8; round++)
        for (let index = 0; index < 2; index++) {
          const clone = (index + round) % 2 === 0;
          await c("HeapProfiler.collectGarbage");
          samples.push(
            await evaluate(
              `(()=>{const clone=${clone};const make=()=>{const row=document.createElement('tr');const first=document.createElement('td');first.appendChild(document.createTextNode('row'));const second=document.createElement('td');second.appendChild(document.createTextNode('0'));row.append(first,second);return row;};const template=make();const nodes=[];const started=performance.now();for(let i=0;i<5000;i++)nodes.push(clone?template.cloneNode(true):make());const elapsed=performance.now()-started;if(nodes.length!==5000||nodes.some(n=>n.cells.length!==2||n.textContent!=='row0'))throw Error('DOM subtree probe failed');return{clone,elapsed};})()`,
            ),
          );
        }
      console.log(JSON.stringify({ variant, domTreeProbe: samples }));
    }
    if (process.env.AUDIT_PROFILE === "1") {
      await c("Profiler.enable");
      await c("Profiler.setSamplingInterval", { interval: 100 });
      await c("Profiler.start");
    }
    const mountMs = await evaluate(
      `(()=>{const c=document.createElement('div');document.getElementById('host').append(c);const t=performance.now();globalThis.auditLive=auditMount(c);globalThis.auditContainer=c;return performance.now()-t;})()`,
    );
    if (process.env.AUDIT_PROFILE === "1") {
      const count = Number(process.env.AUDIT_PROFILE_MOUNTS ?? 1);
      if (count > 1)
        await evaluate(
          `(async()=>{for(let i=1;i<${count};i++){const c=document.createElement('div');document.getElementById('host').append(c);const root=auditMount(c);await root.dispose();c.remove();}})()`,
        );
      const { profile } = await c("Profiler.stop");
      writeFileSync(path.join(root, `ui-${variant}${suffix}.cpuprofile`), JSON.stringify(profile));
    }
    // Outside timing: retain the live root to compare mounting's heap footprint,
    // separately from the post-unmount/GC retention check below.
    await c("HeapProfiler.collectGarbage");
    const liveHeap = await c("Runtime.getHeapUsage");
    const domModel = await evaluate(
      "typeof auditDOMModelStats==='function'?auditDOMModelStats():null",
    );
    const actual = await evaluate(
      `(async()=>{const n=document.querySelectorAll('#host tr').length;await auditLive.dispose();auditContainer.remove();globalThis.auditLive=globalThis.auditContainer=null;return n;})()`,
    );
    if (actual !== 1000) throw Error("Wrong DOM result " + actual);
    const before = await evaluate("auditInspector()");
    for (const framework of frameworks.slice(1)) await evaluate(`auditSample('${framework}',-1)`);
    pages.push({
      variant,
      targetId,
      c,
      evaluate,
      mountMs,
      liveHeap,
      domModel,
      before,
      repeated: [],
      controls: [],
      teardown: [],
      staticSamples: [],
      forSamples: [],
    });
  }
  // Rotate builds as well as frameworks: host-load drift must not consistently
  // favour the build that happens to be measured last. No two samples overlap.
  const cases = frameworks.flatMap((framework) => pages.map((page) => ({ page, framework })));
  if (process.env.AUDIT_SCALE_COMPARE === "1") {
    const { compareScale } = await import("./compare-scale.mjs");
    reports.push(await compareScale({ pages, root, rounds, browserVersion }));
    for (const page of pages) await call("Target.closeTarget", { targetId: page.targetId });
    pages.length = 0;
    cases.length = 0;
  }
  // Optional steady-state supplement. The original full mount/update workload
  // and timers are unchanged; discard the same extra warm-ups for every case.
  for (let round = 0; round < extraWarmupRounds; round++) {
    for (let index = 0; index < cases.length; index++) {
      const { page, framework } = cases[(index + round) % cases.length];
      await page.c("Page.bringToFront");
      await page.evaluate(`auditSample('${framework}',${-1000 - round})`);
    }
  }
  for (let round = 0; round < rounds; round++) {
    for (let index = 0; index < cases.length; index++) {
      const { page, framework } = cases[(index + round) % cases.length];
      await page.c("Page.bringToFront");
      const result = await page.evaluate(`auditSample('${framework}',${round})`);
      (framework === "virentia" ? page.repeated : page.controls).push(result);
    }
  }
  if (process.env.AUDIT_TEARDOWN_PROBE === "1") {
    // Supplemental metric, separate from the unchanged mount/update samples.
    for (let round = 0; round < rounds; round++) {
      for (let index = 0; index < pages.length; index++) {
        const page = pages[(index + round) % pages.length];
        await page.c("Page.bringToFront");
        const elapsed = await page.evaluate(
          "(async()=>{const container=document.createElement('div');document.getElementById('host').append(container);const mounted=auditMount(container);const started=performance.now();await mounted.dispose();const elapsed=performance.now()-started;if(container.childNodes.length)throw Error('Teardown left DOM');container.remove();return elapsed;})()",
        );
        page.teardown.push({ round, unmountMs: elapsed });
      }
    }
  }
  if (process.env.AUDIT_STATIC_PROBE === "1") {
    // Separate after the original metrics; no models or competitor claims.
    for (let round = 0; round < 9; round++) {
      for (let index = 0; index < pages.length; index++) {
        const page = pages[(index + round) % pages.length];
        await page.c("Page.bringToFront");
        await page.c("HeapProfiler.collectGarbage");
        const baseline = await page.c("Runtime.getHeapUsage");
        const mountMs = await page.evaluate(
          "(()=>{const container=document.createElement('div');document.getElementById('host').append(container);globalThis.auditStaticContainer=container;const started=performance.now();globalThis.auditStaticLive=auditStaticMount(container);return performance.now()-started;})()",
        );
        await page.c("HeapProfiler.collectGarbage");
        const live = await page.c("Runtime.getHeapUsage");
        await page.evaluate(
          "(async()=>{const rows=auditStaticContainer.querySelectorAll('p');if(rows.length!==5000||Array.from(rows).reduce((sum,row)=>sum+Number(row.textContent),0)!==12497500)throw Error('Wrong static DOM');await auditStaticLive();if(auditStaticContainer.childNodes.length)throw Error('Static root leaked');auditStaticContainer.remove();globalThis.auditStaticLive=globalThis.auditStaticContainer=null;})()",
        );
        page.staticSamples.push({
          round,
          rows: 5000,
          mountMs,
          livePageHeapDelta: live.usedSize - baseline.usedSize,
        });
      }
    }
  }
  if (process.env.AUDIT_FOR_PROBE === "1") {
    for (let round = 0; round < 9; round++) {
      for (let index = 0; index < pages.length; index++) {
        const page = pages[(index + round) % pages.length];
        await page.c("Page.bringToFront");
        await page.c("HeapProfiler.collectGarbage");
        const baseline = await page.c("Runtime.getHeapUsage");
        const mountMs = await page.evaluate(
          "(()=>{const container=document.createElement('div');document.getElementById('host').append(container);const start=performance.now();globalThis.auditForLive=auditForMount(container);globalThis.auditForContainer=container;return performance.now()-start;})()",
        );
        await page.c("HeapProfiler.collectGarbage");
        const live = await page.c("Runtime.getHeapUsage");
        await page.evaluate(
          "(async()=>{await auditForLive.verify();await auditForLive.dispose();if(auditForContainer.childNodes.length)throw Error('For root leaked');auditForContainer.remove();globalThis.auditForLive=globalThis.auditForContainer=null;})()",
        );
        page.forSamples.push({
          round,
          rows: 1000,
          mountMs,
          livePageHeapDelta: live.usedSize - baseline.usedSize,
        });
      }
    }
  }
  for (const page of pages) {
    const {
      variant,
      targetId,
      c,
      evaluate,
      mountMs,
      liveHeap,
      domModel,
      before,
      repeated,
      controls,
      teardown,
      staticSamples,
    } = page;
    await c("Page.bringToFront");
    const after = await evaluate("auditInspector()");
    await c("HeapProfiler.collectGarbage");
    const heap = await c("Runtime.getHeapUsage");
    const collected = await evaluate("auditInspector()");
    const environment = await evaluate(
      "({userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,viewport:{width:innerWidth,height:innerHeight},devicePixelRatio})",
    );
    const report = {
      forSamples: page.forSamples.length ? page.forSamples : undefined,
      staticSamples: staticSamples.length ? staticSamples : undefined,
      variant,
      measuredAt: new Date().toISOString(),
      order:
        "Balanced rotation across builds and frameworks; isolated page per build; no concurrent samples",
      rounds,
      extraWarmupRounds,
      mountMs,
      repeated,
      controls,
      teardown: teardown.length ? teardown : undefined,
      before,
      after,
      collected,
      heap,
      liveHeap,
      domModel: domModel ?? undefined,
      environment,
      browserVersion,
    };
    reports.push(report);
    console.log(
      JSON.stringify({
        ...report,
        repeated: repeated.map(({ batchMs, ...s }) => s),
        controls: controls.map(({ batchMs, ...s }) => s),
      }),
    );
    await call("Target.closeTarget", { targetId });
  }
  writeFileSync(
    path.join(root, `browser-${process.env.AUDIT_TAG ?? "current"}-results${suffix}.json`),
    JSON.stringify(reports, null, 2),
  );
} finally {
  // Chrome may close its debugging socket before acknowledging Browser.close.
  // Bound shutdown so an already saved result cannot leave the runner parked.
  let shutdownTimeout;
  await Promise.race([
    call("Browser.close").catch(() => {}),
    new Promise((resolve) => {
      shutdownTimeout = setTimeout(resolve, 1000);
    }),
  ]);
  clearTimeout(shutdownTimeout);
  ws.close();
  server.close();
  server.closeAllConnections();
  if (chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, "exit");
    chrome.kill();
    let forceKill;
    try {
      forceKill = setTimeout(() => chrome.kill("SIGKILL"), 1000);
      await exited;
    } finally {
      clearTimeout(forceKill);
    }
  }
  chrome.stderr.destroy();
  rmSync(profileDirectory, { recursive: true, force: true });
}
// Native WebSocket shutdown can keep an idle handle after Chrome has exited.
// This line is reached only on success; thrown benchmark failures still fail.
process.exit(0);

// Assemble checked local evidence for the retained 25k-row optimization pass.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus, loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(directory);
const read = name => JSON.parse(readFileSync(path.join(directory, ".build", name), "utf8"));
const sha = value => createHash("sha256").update(value).digest("hex");
const pairedArtifact = "paired-large-shipped-paired-2026-10-24.json";
const memoryArtifact = "browser-large-shipped-memory-2026-10-24-results-minified.json";
const paired = read(pairedArtifact), memory = read(memoryArtifact);
if (!paired.complete || paired.samples.length !== 16) throw Error("Incomplete final paired evidence");
for (const sample of paired.samples) {
  if (sample.n !== 25000 || sample.stride !== 10 || sample.batches !== 25 ||
      sample.checksum !== 62500 || sample.batchMs.length !== 25 ||
      Math.abs(sample.totalMs - sample.mountMs - sample.batchMs.reduce((a,b) => a+b, 0)) > 1e-6)
    throw Error("Final paired sample failed validation");
}
for (const report of memory) for (const sample of report.heap) {
  if (sample.domNodesDelta !== 125003 || sample.afterDOM.nodes !== sample.beforeDOM.nodes)
    throw Error("Final live/disposed DOM counts differ");
}
const validation = read("validation-large-final-retained-2026-10-24-summary.json");
if (validation.runtime.some(p => p.testsFailed) || !validation.rootTypes || !validation.smoke)
  throw Error("Final package validation failed");
const profile = label => {
  const analysis = read(`render-${label}-analysis.json`);
  return { artifact: `.build/render-${label}-analysis.json`,
    profiles: analysis.profiles.map(p => ({ ...p,
      self: p.self.slice(0, 12), inclusive: p.inclusive.slice(0, 10) })),
    allocation: analysis.allocation.map(a => ({ ...a, self: a.self.slice(0, 15) })),
  };
};
const map = read("ui-large-before-minified.mjs.map");
const sources = ["packages/core/lib/models/collection.ts", "packages/ui/lib/lifetime.ts",
  "packages/core/lib/models/definition.ts", "packages/core/lib/units/store.ts", "packages/ui/lib/runtime.ts"];
const sourceHashes = Object.fromEntries(sources.map(file => {
  const i = map.sources.findIndex(s => s.endsWith(file));
  const before = i < 0 ? null : sha(map.sourcesContent[i]);
  const after = sha(readFileSync(path.join(repo, file)));
  return [file, { before, after, changed: before !== after }];
}));
const pairedRounds = Array.from({ length: paired.rounds }, (_, round) => {
  const before = paired.samples.find(s => s.round === round && s.build === paired.builds[0]);
  const after = paired.samples.find(s => s.round === round && s.build === paired.builds[1]);
  return { round, ...Object.fromEntries(["mountMs", "updateMs", "unmountMs", "lifecycleCommitMs"]
    .map(k => [k, after[k] - before[k]])) };
});
const live = memory.map(r => ({ build: r.variant,
  ...r.heap.map(h => ({ jsLiveDelta: h.jsLiveDelta, jsReleasedDelta: h.jsReleasedDelta,
    embedderLiveDelta: h.embedderLiveDelta, domNodesDelta: h.domNodesDelta,
    domNodesRemaining: h.afterDOM.nodes - h.beforeDOM.nodes }))[0],
}));
console.log(JSON.stringify({
  schemaVersion: 1, date: "2026-10-24", status: "Three ownership/disposal changes retained. No mount-parity or universal renderer-win claim.",
  workload: { rows: 25000, components: 25000, nativeElements: 75002, textNodes: 50000,
    batches: 25, changedCellsPerBatch: 2500, virtualization: false },
  machine: { cpu: cpus()[0].model, cores: cpus().length, platform: process.platform,
    arch: process.arch, node: process.version, loadAtAssembly: loadavg() },
  methodology: {
    timings: "Unchanged production automatic JSX workload. Paired serial A/B, 8 rounds, alternating build order each round; two equal full warmups. DOM/checksum validation is outside timers. No concurrent heavy work launched by this task.",
    aggregate: "Lifecycle = per-sample mount + 25 update intervals + awaited unmount. Explicit layout and intentional rAF waits are excluded from this metric. Paired deltas are median(after-before) within rounds, not a difference of separately computed medians.",
    load: "HIGH external host load: approximately 33 to 15 load average on 10 cores during the final run. Absolute CPU/latency values are not representative of a quiet host. Mount gain was not stable; no such claim is made. Do not compare these absolute values to earlier quiet-host reports.",
    memory: "Separate GC-controlled live-root probes. JS and Blink/embedder heaps are separate, never added or called RSS. All 125003 added DOM nodes (including the external container) return to baseline after disposal/GC.",
    profiles: "Source-mapped 100us CPU sampling and Chrome timeline traces identify stacks, not headline timings. Initial and final traces have different host load and must not be used for a before/after speed ratio. Allocation sampling includes collected objects and is an estimate, not exact peak heap.",
    flags: ["--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"],
    scope: "Synthetic full table. Not a general app, SSR/hydration, insertion/reorder, GPU paint or universal React/Vue comparison.",
  },
  retainedChanges: [
    "Bound pending recycling reservations together with the final free list (1024). A 25k disposal burst no longer schedules 25k recycling microtasks only to discard most records.",
    "A model without relation/owned-child edges needs no cycle Set or visitor closure for its disposal tree. Validation, callbacks, reentrancy and delete policies remain on the original path.",
    "Inline cleanup buffer for up to six resources, with original reverse order, cancellation, deduplication, snapshot semantics and Array/Set spillover. Native DOM ownership and async lifecycle ordering are unchanged.",
  ],
  measurements: { pairedArtifact: `.build/${pairedArtifact}`, paired, pairedRounds,
    memoryArtifact: `.build/${memoryArtifact}`, memory: live,
    memoryPercentReduction: (1 - live[1].jsReleasedDelta / live[0].jsReleasedDelta) * 100 },
  profiles: [profile("large-before-large"), profile("large-before-alloc-baseline"), profile("large-shipped-retained-profile")],
  validation, sourceHashes,
  bundles: Object.fromEntries(["large-before", "large-shipped"].map(v => [v,
    sha(readFileSync(path.join(directory, ".build", `ui-${v}-minified.mjs`)))])),
  reproduction: {
    build: "AUDIT_VARIANT=large-shipped AUDIT_ROWS=25000 AUDIT_STRIDE=10 AUDIT_JSX=1 AUDIT_REACT_JSX=1 AUDIT_SOURCE_MAP=1 node benchmarks/build.mjs --deps <dependency-directory>",
    paired: "AUDIT_VARIANTS=large-before,large-shipped AUDIT_CONTROLS=0 AUDIT_SCALE_COMPARE=1 AUDIT_ROUNDS=8 AUDIT_TAG=large-shipped-paired-2026-10-24 node benchmarks/run-browser.mjs minified",
    memory: "AUDIT_VARIANTS=large-before,large-shipped AUDIT_CONTROLS=0 AUDIT_SCALE=1 AUDIT_SCALE_MEMORY_ONLY=1 AUDIT_TAG=large-shipped-memory-2026-10-24 node benchmarks/run-browser.mjs minified",
    profile: "AUDIT_VARIANTS=large-shipped AUDIT_SCALE_PROFILE=1 AUDIT_SCALE_PROFILE_TRIALS=1 AUDIT_SCALE_PROFILE_LABEL=retained-profile AUDIT_SCALE_ALLOCATION=1 AUDIT_TAG=large-shipped-profile-2026-10-24 node benchmarks/run-browser.mjs minified",
    baseline: "large-before is the frozen pre-change bundle (SHA included), not a rebuild from changed sources. Exact baseline TypeScript is retained in its external sourcemap.",
  },
}));

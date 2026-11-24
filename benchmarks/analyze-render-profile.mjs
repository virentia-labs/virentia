// Source-mapped sampling analysis. Exclusive rows sum to 100%; inclusive
// anchors overlap and must never be added together. GC/layout use trace events.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), ".build");
const variant = process.argv[2] ?? "render-audit-jsx";
const label = process.argv[3] ?? variant;
const report = JSON.parse(readFileSync(path.join(root, `render-${label}-report.json`), "utf8"));
const map = JSON.parse(readFileSync(path.join(root, `ui-${variant}-minified.mjs.map`), "utf8"));
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
let source = 0,
  sourceLine = 0,
  sourceColumn = 0,
  name = 0;
const mappings = map.mappings.split(";").map((line) => {
  let column = 0;
  return line
    .split(",")
    .filter(Boolean)
    .map((encoded) => {
      const fields = [];
      let value = 0,
        shift = 0;
      for (const letter of encoded) {
        const digit = alphabet.indexOf(letter);
        value += (digit & 31) * 2 ** shift;
        if (digit & 32) shift += 5;
        else {
          fields.push(value & 1 ? -(value >> 1) : value >> 1);
          value = shift = 0;
        }
      }
      column += fields[0];
      if (fields.length === 1) return { column };
      source += fields[1];
      sourceLine += fields[2];
      sourceColumn += fields[3];
      if (fields.length > 4) name += fields[4];
      return {
        column,
        source,
        line: sourceLine,
        sourceColumn,
        name: fields.length > 4 ? map.names[name] : undefined,
      };
    });
});

const sourceFunctions = map.sources.map((source, index) => {
  const content = map.sourcesContent[index];
  const file = ts.createSourceFile(source, content, ts.ScriptTarget.Latest, true);
  const ranges = [];
  function visit(node, parents = []) {
    let current = parents;
    if (ts.isClassLike(node) && node.name) current = [...parents, node.name.text];
    if (ts.isFunctionLike(node) && node.body) {
      const name =
        node.name?.getText(file) ??
        (ts.isConstructorDeclaration(node)
          ? "constructor"
          : (node.parent.name?.getText(file) ?? "callback"));
      current = [...current, name];
      ranges.push({
        start: node.getStart(file),
        end: node.end,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        names: current,
      });
    }
    ts.forEachChild(node, (child) => visit(child, current));
  }
  visit(file);
  return { file, ranges };
});

const mappedCache = new Map();
function original(frame) {
  if (!frame.url?.includes(`ui-${variant}-minified.mjs`)) return null;
  const key = `${frame.lineNumber}:${frame.columnNumber}`;
  if (mappedCache.has(key)) return mappedCache.get(key);
  const line = mappings[frame.lineNumber] ?? [];
  let lo = 0,
    hi = line.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (line[mid].column <= frame.columnNumber) lo = mid + 1;
    else hi = mid;
  }
  const segment = line[lo - 1];
  if (segment?.source === undefined) return null;
  const source = map.sources[segment.source];
  const { file, ranges } = sourceFunctions[segment.source];
  const pos = file.getPositionOfLineAndCharacter(segment.line, segment.sourceColumn);
  const range = ranges
    .filter((range) => range.start <= pos && pos < range.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
  const names = range?.names ?? [segment.name ?? frame.functionName];
  const meaningful = names.filter((name) => name !== "callback");
  const result = {
    source,
    line: range?.line ?? segment.line + 1,
    names,
    name: meaningful.join("."),
    symbol: segment.name,
    label: `${source.replace(/^\.\.\//g, "")}:${range?.line ?? segment.line + 1} ${meaningful.join(".")}`,
  };
  mappedCache.set(key, result);
  return result;
}

const domNames = new Set([
  "appendChild",
  "insertBefore",
  "createElement",
  "createElementNS",
  "createTextNode",
  "createDocumentFragment",
  "setAttribute",
  "setAttributeNS",
  "append",
  "set textContent",
  "set nodeValue",
  "set data",
  "cloneNode",
  "removeChild",
  "remove",
  "replaceChildren",
]);
function category(frame, mapped, ancestor) {
  if (frame.functionName === "(garbage collector)") return "GC (CPU samples)";
  if (!frame.url && frame.functionName === "mark") return "Diagnostic marks (boundary uncertainty)";
  if (!frame.url && domNames.has(frame.functionName)) return "DOM native calls";
  if (!mapped) {
    if (frame.functionName === "(idle)") return "Idle / scheduled wait";
    if (frame.functionName === "(program)") return "Browser / VM (unattributed)";
    if (ancestor) return category(ancestor.frame, ancestor.mapped);
    return "Other / diagnostic boundary";
  }
  const { source, names } = mapped;
  const has = (...targets) => names.some((name) => targets.includes(name));
  if (source.includes("/core/lib/models/")) return "Core model / facade / registry";
  if (source.includes("/core/lib/scope/")) return "Core scope";
  if (source.includes("/core/lib/kernel/") || source.includes("/core/lib/graph/"))
    return "Core graph / tracking";
  if (source.includes("/core/lib/")) return "Other Core";
  if (source.endsWith("/ui/lib/lifetime.ts")) return "UI lifetime / ownership";
  if (
    source.endsWith("/ui/lib/jsx-runtime.ts") ||
    (source.endsWith("/ui/lib/runtime.ts") &&
      has(
        "createElement",
        "keyedElement",
        "KeyDescription",
        "KeyProps",
        "NativeDescription",
        "OwnedDescription",
        "ChildProps",
      ))
  )
    return "JSX descriptions / props wrappers";
  if (source.endsWith("/ui/lib/runtime.ts")) {
    if (
      has(
        "childContext",
        "nativeElementContext",
        "ChildPath",
        "OwnedContext",
        "runIn",
        "trackedRead",
        "createRootContext",
      )
    )
      return "UI context / read frames";
    if (
      has(
        "bindElementProperties",
        "bindElementProperty",
        "bindAttribute",
        "patchProperty",
        "bindElementClasses",
        "normalizedStyle",
        "patchStyle",
        "isClassProperty",
      )
    )
      return "UI attributes / prop discovery";
    if (
      has(
        "NativeTextBinding",
        "bindNativeText",
        "mountReadable",
        "domObserver",
        "isScalar",
        "scalarText",
      )
    )
      return "UI text binding setup";
    if (
      has(
        "componentView",
        "ComponentState",
        "ComponentProps",
        "ViewSelf",
        "propsFacade",
        "plainProps",
        "constructorProps",
        "recordFor",
        "componentRecordOf",
        "typeName",
        "sourceContextOf",
        "assertModel",
        "bindComponentInputs",
        "hasComponentInputs",
        "fieldKeysOf",
        "updateComponentProps",
        "bindComponentLifecycle",
      )
    )
      return "UI component / model attachment";
    return "UI tree dispatch / other";
  }
  if (source.endsWith("ui.harness.ts")) return "App view / root factory";
  if (/\/(?:react|react-dom|scheduler)\//.test(source)) return "React runtime";
  if (/\/(?:@vue|vue)\//.test(source)) return "Vue runtime";
  return source;
}
const add = (target, key, value) => (target[key] = (target[key] ?? 0) + value);
function overlap(start, end, ranges) {
  let duration = 0;
  for (const range of ranges)
    duration += Math.max(0, Math.min(end, range.end) - Math.max(start, range.start));
  return duration;
}
function union(ranges) {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const previous = out.at(-1);
    if (previous && r.start <= previous.end) previous.end = Math.max(previous.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

const outputs = [];
for (const entry of report.profiles) {
  const cpu = JSON.parse(readFileSync(entry.cpu, "utf8"));
  const events = JSON.parse(readFileSync(entry.trace, "utf8")).traceEvents;
  const starts = new Map(
    events.filter((e) => /^profile:\d+:start$/.test(e.name)).map((e) => [e.name.slice(0, -6), e]),
  );
  const ranges = events
    .filter((e) => /^profile:\d+:end$/.test(e.name))
    .map((e) => ({
      start: starts.get(e.name.slice(0, -4)).ts,
      end: e.ts,
      tid: e.tid,
    }))
    .sort((a, b) => a.start - b.start);
  const nodes = new Map(
    cpu.nodes.map((node) => [
      node.id,
      {
        ...node,
        mapped: original(node.callFrame),
        parent: undefined,
      },
    ]),
  );
  for (const node of nodes.values())
    for (const child of node.children ?? []) nodes.get(child).parent = node;
  let time = cpu.startTime;
  const timed = cpu.samples
    .map((id, index) => ({ id, time: (time += cpu.timeDeltas[index]) }))
    .sort((a, b) => a.time - b.time);
  const self = {},
    inclusive = {},
    categories = {};
  let sampled = 0,
    gcSamples = 0;
  for (let i = 0; i < timed.length; i++) {
    const { id, time } = timed[i];
    const weight = overlap(time, timed[i + 1]?.time ?? cpu.endTime, ranges) / 1000;
    if (!weight) continue;
    const leaf = nodes.get(id),
      chain = [];
    for (let node = leaf; node; node = node.parent) chain.push(node);
    const ancestor = chain.find((node) => node.mapped);
    const group = category(
      leaf.callFrame,
      leaf.mapped,
      ancestor && { frame: ancestor.callFrame, mapped: ancestor.mapped },
    );
    add(categories, group, weight);
    add(self, (leaf.mapped?.label ?? leaf.callFrame.functionName) || "native (unnamed)", weight);
    for (const label of new Set(chain.flatMap((node) => (node.mapped ? [node.mapped.label] : []))))
      add(inclusive, label, weight);
    sampled += weight;
    if (leaf.callFrame.functionName === "(garbage collector)") gcSamples += weight;
  }
  const tid = ranges[0].tid;
  const mainEvents = events.filter((e) => e.ph === "X" && e.tid === tid && e.dur > 0);
  const gcIntervals = union(
    mainEvents
      .filter((e) =>
        [
          "MinorGC",
          "MajorGC",
          "V8.GCIncrementalMarking",
          "V8.GCIncrementalMarkingStart",
          "V8.GCScavenger",
          "V8.GCFinalizeMC",
        ].includes(e.name),
      )
      .map((e) => ({ start: e.ts, end: e.ts + e.dur })),
  );
  const timeline = {};
  for (const name of [
    "Layout",
    "UpdateLayoutTree",
    "PrePaint",
    "Paint",
    "Layerize",
    "V8.DeoptimizeCode",
  ]) {
    const intervals = union(
      mainEvents.filter((e) => e.name === name).map((e) => ({ start: e.ts, end: e.ts + e.dur })),
    );
    timeline[name] = intervals.reduce((sum, e) => sum + overlap(e.start, e.end, ranges) / 1000, 0);
  }
  const top = (values) => Object.entries(values).sort((a, b) => b[1] - a[1]);
  outputs.push({
    framework: entry.framework,
    phase: entry.phase ?? "warm-mount",
    trial: entry.trial,
    mounts: ranges.length,
    wallMs: ranges.reduce((sum, range) => sum + (range.end - range.start) / 1000, 0),
    sampledMs: sampled,
    mainThreadGCMs: gcIntervals.reduce((sum, e) => sum + overlap(e.start, e.end, ranges) / 1000, 0),
    gcSamplesMs: gcSamples,
    timeline,
    exclusive: top(categories).map(([category, ms]) => ({
      category,
      ms,
      percent: (ms / sampled) * 100,
      perMountMs: ms / ranges.length,
    })),
    self: top(self).map(([function_, ms]) => ({
      function: function_,
      ms,
      percent: (ms / sampled) * 100,
    })),
    inclusive: top(inclusive).map(([function_, ms]) => ({
      function: function_,
      ms,
      percent: (ms / sampled) * 100,
    })),
    diagnostic: {
      samples: cpu.samples.length,
      zeroDeltas: cpu.timeDeltas.filter((d) => d === 0).length,
      negativeDeltas: cpu.timeDeltas.filter((d) => d < 0).length,
      deltaMs: cpu.timeDeltas.reduce((a, b) => a + b, 0) / 1000,
    },
  });
}
const allocation = [];
for (const framework of new Set([
  "virentia",
  "react",
  "vue",
  ...(report.allocationSampling?.frameworks ?? []),
])) {
  const file = path.join(root, `render-${label}-${framework}.heapprofile`);
  if (!existsSync(file)) continue;
  const heap = JSON.parse(readFileSync(file, "utf8")),
    categories = {},
    self = {},
    teardownSelf = {};
  let total = 0,
    teardown = 0;
  function visit(node, ancestors = []) {
    const chain = [...ancestors, node];
    if (chain.some((n) => n.callFrame.functionName === "globalThis.auditDiagnosticDispose")) {
      teardown += node.selfSize;
      const mapped = original(node.callFrame);
      add(teardownSelf, mapped?.label ?? node.callFrame.functionName ?? "native", node.selfSize);
    } else {
      const mapped = original(node.callFrame);
      const ancestor = [...chain]
        .reverse()
        .map((n) => ({ frame: n.callFrame, mapped: original(n.callFrame) }))
        .find((n) => n.mapped);
      add(categories, category(node.callFrame, mapped, ancestor), node.selfSize);
      add(self, mapped?.label ?? node.callFrame.functionName ?? "native", node.selfSize);
      total += node.selfSize;
    }
    for (const child of node.children ?? []) visit(child, chain);
  }
  visit(heap.head);
  allocation.push({
    framework,
    mounts: report.allocationSampling?.mounts ?? 20,
    estimatedMountBytes: total,
    excludedTeardownBytes: teardown,
    teardownSelf: Object.entries(teardownSelf).sort((a, b) => b[1] - a[1]),
    categories: Object.entries(categories).sort((a, b) => b[1] - a[1]),
    self: Object.entries(self).sort((a, b) => b[1] - a[1]),
  });
}
const result = {
  variant,
  methodology: {
    exclusive:
      "Top sampled frame mapped to original TypeScript. Native DOM calls separate. Unmapped VM frames remain unattributed. No summation of inclusive call trees.",
    windows:
      "UserTiming marks share Chrome TimeTicks with CPU profile; teardown, frame wait, layout after commit excluded. Negative sample timestamps sorted chronologically; durations clipped to mark intervals.",
    gc: "Union of main-thread GC trace spans overlapping mount marks; not nested phase sums.",
    allocations: `Sampling, ${report.allocationSampling?.interval ?? 8192} byte interval, ${report.allocationSampling?.mounts ?? 20} mount+dispose cycles with collected objects included. Validation+teardown stacks excluded; async browser/VM allocation attribution may remain partial.`,
  },
  cold: report.cold,
  unprofiled: report.unprofiled,
  heap: report.heap,
  profiles: outputs,
  allocation,
};
writeFileSync(path.join(root, `render-${label}-analysis.json`), JSON.stringify(result, null, 2));
for (const output of outputs)
  console.log(
    JSON.stringify({
      framework: output.framework,
      phase: output.phase,
      trial: output.trial,
      mounts: output.mounts,
      wallPerMount: output.wallMs / output.mounts,
      cpuPerMount: output.sampledMs / output.mounts,
      gcPerMount: output.mainThreadGCMs / output.mounts,
      timeline: output.timeline,
      ...(process.env.AUDIT_RENDER_ANALYSIS_QUIET === "1"
        ? {}
        : {
            exclusive: output.exclusive,
            self: output.self.slice(0, 18),
            inclusive: output.inclusive.slice(0, 18),
            diagnostic: output.diagnostic,
          }),
    }),
  );
if (process.env.AUDIT_RENDER_ANALYSIS_QUIET !== "1")
  for (const item of allocation)
    console.log(JSON.stringify({ ...item, self: item.self.slice(0, 20) }));

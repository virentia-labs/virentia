import type { Node } from "../kernel";
import { getActiveRealScope, getActiveScope } from "../scope/internal";
import { trackMicroDependency } from "../scope/micro";
import type { Scope } from "../scope/types";

type Collector = Set<Node> | true;

// A Set captures every source; true selects the compact synchronous stack slots.
// Nested reads save/restore those slots instead of allocating a collector closure.
let collector: Collector | null = null;
// The first two distinct sources a compact collector meets; a third makes a Set.
let collectedSource: Node | undefined;
let collectedSecond: Node | undefined;
let collectedNodes: Set<Node> | undefined;
// A computed re-evaluating with many reads matches them against its previous
// reads in order first (see `collectReadsInto`): while they match, nothing is
// collected. On the first difference the matched prefix is collected and the
// reads from there on are recorded for the next evaluation.
let expectedReads: readonly Node[] | undefined;
let expectedAt = 0;
let recordedReads: Node[] | undefined;
interface ReadBoundary {
  readonly depth: number;
  readonly task?: unknown;
}
// Synchronous read frames live on the JavaScript stack. Do not retain all of
// their bookkeeping on the small value/dependencies result that can escape.
let readScope: Scope | undefined;
let readKernelDepth = 0;
let readTask: unknown;
let readBoundary: ReadBoundary | undefined;
let readDepth = 0;
let readDependencies: Set<Node> | undefined;
let kernelReadBoundary: ReadBoundary | undefined;
const emptyReadDependencies: ReadonlySet<Node> = new Set();

/** @internal Observe existing kernel/task frames without changing their hot paths. */
export function setKernelReadBoundary(boundary: ReadBoundary): void {
  kernelReadBoundary = boundary;
}

function isScopedRead(scope: Scope | null): boolean {
  return (
    readScope === scope &&
    readKernelDepth === (kernelReadBoundary?.depth ?? 0) &&
    readTask === kernelReadBoundary?.task &&
    readDepth === (readBoundary?.depth ?? 0)
  );
}

/** @internal Synchronous renderer reads need no await-capable scope overlay. */
export function collectScopedNodes<T>(
  scope: Scope,
  read: () => T,
  boundary?: ReadBoundary,
): {
  value: T;
  dependencies: ReadonlySet<Node>;
} {
  // Boundary getters may re-enter a reader, or add dependencies to its parent.
  // Evaluate them before snapshotting that parent's mutable dependency set.
  const kernelDepth = kernelReadBoundary?.depth ?? 0;
  const task = kernelReadBoundary?.task;
  const depth = boundary?.depth ?? 0;
  const previousScope = readScope;
  const previousKernelDepth = readKernelDepth;
  const previousTask = readTask;
  const previousBoundary = readBoundary;
  const previousDepth = readDepth;
  const previousDependencies = readDependencies;
  readScope = scope;
  readKernelDepth = kernelDepth;
  readTask = task;
  readBoundary = boundary;
  readDepth = depth;
  readDependencies = undefined;
  try {
    const value = read();
    return { value, dependencies: readDependencies ?? emptyReadDependencies };
  } finally {
    readScope = previousScope;
    readKernelDepth = previousKernelDepth;
    readTask = previousTask;
    readBoundary = previousBoundary;
    readDepth = previousDepth;
    readDependencies = previousDependencies;
  }
}


export function trackNode(node: Node): void {
  // Inside a `collectNodes` window (computed evaluation, or a synchronous
  // reaction collect) the node belongs to that collector — and NOT to any
  // ambient micro-scope, so a computed's inner reads don't leak into the
  // reaction that read the computed ("не вглубь").
  const current = collector;
  if (current) {
    if (current !== true) current.add(node);
    else {
      if (expectedReads !== undefined) {
        if (expectedReads[expectedAt] === node) {
          expectedAt++;
          return;
        }
        divergeFromExpectedReads();
      }
      if (recordedReads !== undefined) recordedReads.push(node);
      collectSource(node);
    }
    return;
  }

  // Otherwise a direct read in a micro-scoped reaction body is a dependency of
  // that reaction run. This path also fires after an `await`, because the
  // micro-scope stays the ambient scope across effect awaits.
  const scope = getActiveScope();

  if (readScope !== undefined && isScopedRead(scope)) {
    (readDependencies ??= new Set()).add(node);
    return;
  }

  // Only a micro-scope differs from the real scope behind it.
  if (scope !== null && scope !== getActiveRealScope()) trackMicroDependency(scope, node);
}

// True while a read would register as a dependency — inside a `collectNodes`
// window (computed / sync reaction collect) or a micro-scoped reaction run. Lets
// a custom store skip building fine-grained dependency keys on reads that nobody
// is tracking (a plain mutation), keeping the write path free of that cost.
export function isTracking(): boolean {
  if (collector) return true;
  const scope = getActiveScope();
  // Only a micro-scope differs from the real scope behind it.
  return (
    (readScope !== undefined && isScopedRead(scope)) ||
    (scope !== null && scope !== getActiveRealScope())
  );
}

/**
 * @internal Read a value whose dependency the caller has already registered in
 * another form (a cross-scope read bridge). Nothing read inside reaches the
 * caller's collector or synchronous read frame.
 */
export function untrackedRead<T>(read: () => T): T {
  const previousCollector = collector,
    previousScope = readScope;
  if (previousCollector === null && previousScope === undefined) return read();
  collector = null;
  readScope = undefined;
  try {
    return read();
  } finally {
    collector = previousCollector;
    readScope = previousScope;
  }
}

/** @internal Native maps already declare their parent edge; keep public capture intact. */
export function isCollectingNodeSources(): boolean {
  return collector === true;
}

export function collectNodes<T>(fn: () => T): { result: T; nodes: Set<Node> } {
  const previousCollector = collector;
  const nodes = new Set<Node>();
  collector = nodes;

  try {
    return { result: fn(), nodes };
  } finally {
    collector = previousCollector;
  }
}

export interface CollectedNodeSources<T> {
  result: T;
  source?: Node;
  nodes?: Set<Node>;
}

/**
 * @internal The computed consumes/clears this output before dependency
 * reconciliation: one source in `source`, two in `source` and `second`, more
 * in `nodes` alone.
 */
export function collectNodeSourcesInto<T>(
  fn: () => T,
  capture: { source?: Node; second?: Node; nodes?: Set<Node> },
): T {
  const previous = collector;
  const previousSource = collectedSource,
    previousSecond = collectedSecond,
    previousNodes = collectedNodes;
  const previousExpected = expectedReads,
    previousRecorded = recordedReads;
  collector = true;
  collectedSource = collectedSecond = undefined;
  collectedNodes = undefined;
  expectedReads = undefined;
  recordedReads = undefined;
  try {
    const result = fn();
    capture.source = collectedSource;
    capture.second = collectedNodes ? undefined : collectedSecond;
    capture.nodes = collectedNodes;
    return result;
  } finally {
    collector = previous;
    collectedSource = previousSource;
    collectedSecond = previousSecond;
    collectedNodes = previousNodes;
    expectedReads = previousExpected;
    recordedReads = previousRecorded;
  }
}

function collectSource(node: Node): void {
  if (collectedNodes) collectedNodes.add(node);
  else if (collectedSource === undefined) collectedSource = node;
  else if (collectedSource === node) return;
  else if (collectedSecond === undefined) collectedSecond = node;
  else if (collectedSecond !== node) {
    // Built up rather than from an array: the iterable constructor is slower.
    const nodes = (collectedNodes = new Set<Node>());
    nodes.add(collectedSource);
    nodes.add(collectedSecond);
    nodes.add(node);
  }
}

/** The reads stopped matching: collect the matched prefix and record from there. */
function divergeFromExpectedReads(): void {
  const expected = expectedReads!,
    matched = expectedAt;
  expectedReads = undefined;
  recordedReads = expected.slice(0, matched);
  for (let index = 0; index < matched; index++) collectSource(expected[index]);
}

/** What `collectReadsInto` found: the same reads as expected, or the new sources and reads. */
export interface ReadCapture {
  same: boolean;
  source: Node | undefined;
  second: Node | undefined;
  nodes: Set<Node> | undefined;
  reads: Node[] | undefined;
}

/**
 * @internal As `collectNodeSourcesInto`, for a computed that knows the reads of
 * its previous evaluation: when `fn` reads exactly those again, in order, the
 * capture is `same` and nothing was collected. Otherwise it holds the sources
 * and the new reads in order.
 */
export function collectReadsInto<T>(
  fn: () => T,
  capture: ReadCapture,
  expected: readonly Node[],
): T {
  const previous = collector;
  const previousSource = collectedSource,
    previousSecond = collectedSecond,
    previousNodes = collectedNodes,
    previousExpected = expectedReads,
    previousAt = expectedAt,
    previousRecorded = recordedReads;
  collector = true;
  collectedSource = collectedSecond = undefined;
  collectedNodes = undefined;
  expectedReads = expected;
  expectedAt = 0;
  recordedReads = undefined;
  try {
    const result = fn();
    // Fewer reads than before is a difference too.
    if (expectedReads !== undefined && expectedAt !== expected.length) divergeFromExpectedReads();
    capture.same = expectedReads !== undefined;
    capture.source = collectedSource;
    capture.second = collectedNodes ? undefined : collectedSecond;
    capture.nodes = collectedNodes;
    capture.reads = recordedReads;
    return result;
  } finally {
    collector = previous;
    collectedSource = previousSource;
    collectedSecond = previousSecond;
    collectedNodes = previousNodes;
    expectedReads = previousExpected;
    expectedAt = previousAt;
    recordedReads = previousRecorded;
  }
}

/** @internal Computeds usually read one source; materialize a Set only for fan-in. */
export function collectNodeSources<T>(fn: () => T): CollectedNodeSources<T> {
  const previous = collector;
  const previousSource = collectedSource,
    previousSecond = collectedSecond,
    previousNodes = collectedNodes,
    previousExpected = expectedReads,
    previousRecorded = recordedReads;
  collector = true;
  collectedSource = collectedSecond = undefined;
  collectedNodes = undefined;
  expectedReads = undefined;
  recordedReads = undefined;
  try {
    // Only the returned result can escape, not a globally rooted capture record.
    const result = fn();
    const nodes =
      collectedNodes ??
      (collectedSecond === undefined ? undefined : new Set([collectedSource!, collectedSecond]));
    return { result, source: collectedSource, nodes };
  } finally {
    collector = previous;
    collectedSource = previousSource;
    collectedSecond = previousSecond;
    collectedNodes = previousNodes;
    expectedReads = previousExpected;
    recordedReads = previousRecorded;
  }
}

import type { Scope } from "../scope";
import type { Node } from "./types";

export const inspectorMetaKey = "virentia.inspector";

export type InspectorEvent =
  | {
      type: "node-created";
      node: Node;
    }
  | {
      type: "scope-created";
      scope: Scope;
    }
  | {
      type: "node-start";
      node: Node;
      scope: Scope | null;
      payload: unknown;
      value: unknown;
      meta: Record<string, unknown>;
      timestamp: number;
    }
  | {
      type: "node-end";
      node: Node;
      scope: Scope | null;
      payload: unknown;
      value: unknown;
      error: unknown;
      failed: boolean;
      stopped: boolean;
      meta: Record<string, unknown>;
      timestamp: number;
      duration: number;
    }
  | {
      type: "breakpoint-hit";
      node: Node;
      scope: Scope | null;
      payload: unknown;
      value: unknown;
      meta: Record<string, unknown>;
      timestamp: number;
    };

export type InspectorListener = (event: InspectorEvent) => void;

export interface InspectorNodeMeta {
  type?: string;
  name?: string;
  key?: boolean;
  callable?: boolean;
  writable?: boolean;
  internal?: boolean;
  description?: string;
  /** Name of the nearest factory this node was created in (effector: `withFactory({ name })`). */
  factory?: string;
  /** Source location ("path/to/file.ts:line:column") when the app is built with `addLoc`. */
  loc?: string;
  /** Stable unit id when the app is built with a sid-generating plugin. */
  sid?: string;
}

export interface InspectorScopeMeta {
  name?: string;
}

export interface InspectorNodeSnapshot {
  id: string;
  name: string;
  type: string;
  key: boolean;
  callable: boolean;
  writable: boolean;
  internal: boolean;
  parentId?: string;
  parentRole?: string;
  meta: InspectorNodeMeta;
}

export type InspectorEdgeKind = "owner" | "reactive";

export interface InspectorEdgeSnapshot {
  id: string;
  source: string;
  target: string;
  kind: InspectorEdgeKind;
}

export interface InspectorScopeSnapshot {
  id: string;
  name: string;
}

export interface InspectorSnapshot {
  nodes: InspectorNodeSnapshot[];
  edges: InspectorEdgeSnapshot[];
  scopes: InspectorScopeSnapshot[];
  breakpoints: string[];
}

const nodes = new Set<Node>();
const scopes = new Set<Scope>();
const listeners = new Set<InspectorListener>();
const nodeIds = new WeakMap<Node, string>();
const scopeIds = new WeakMap<Scope, string>();
const nodeById = new Map<string, Node>();
const scopeById = new Map<string, Scope>();
const scopeMeta = new WeakMap<Scope, InspectorScopeMeta>();
const snapshotPreparers = new WeakMap<Node, () => void>();
const nodeParents = new WeakMap<Node, { parent: Node; role: string }>();
const nodeLinks: InspectorNodeLink[] = [];
const breakpoints = new Set<string>();

let enabled = false;
let nextNodeId = 0;
let nextScopeId = 0;

interface InspectorNodeLink {
  source: Node;
  target: Node;
  kind: InspectorEdgeKind;
  role?: string;
}

export function enableInspector(): () => void {
  enabled = true;

  return () => {
    if (!listeners.size) {
      enabled = false;
    }
  };
}

export function isInspectorEnabled(): boolean {
  return enabled;
}

export function onInspectorEvent(listener: InspectorListener): () => void {
  listeners.add(listener);
  enabled = true;

  return () => {
    listeners.delete(listener);

    if (!listeners.size) {
      enabled = false;
    }
  };
}

export function createInspectorMeta(meta: InspectorNodeMeta): Record<string, unknown> {
  return {
    [inspectorMetaKey]: meta,
  };
}

export function withInspectorMeta(
  meta: Record<string, unknown> | undefined,
  inspector: InspectorNodeMeta,
): Record<string, unknown> {
  return {
    ...meta,
    [inspectorMetaKey]: {
      ...readInspectorNodeMetaFromRecord(meta),
      ...inspector,
    },
  };
}

export function annotateInspectorNode(node: Node, meta: InspectorNodeMeta): void {
  node.meta = withInspectorMeta(node.meta, meta);

  if (enabled) {
    const known = nodes.has(node);

    registerInspectorNode(node);

    if (known) {
      emit({ type: "node-created", node });
    }
  }
}

export function annotateInspectorScope(scope: Scope, meta: InspectorScopeMeta): void {
  scopeMeta.set(scope, {
    ...scopeMeta.get(scope),
    ...meta,
  });

  if (enabled) {
    const known = scopes.has(scope);

    registerInspectorScope(scope);

    if (known) {
      emit({ type: "scope-created", scope });
    }
  }
}

export function registerInspectorNode(node: Node): void {
  const known = nodes.has(node);

  if (!known) {
    nodes.add(node);
    getInspectorNodeId(node);
  }

  if (!enabled || known) {
    return;
  }

  emit({ type: "node-created", node });
}

export function registerInspectorScope(scope: Scope | null | undefined): void {
  if (!scope) {
    return;
  }

  const known = scopes.has(scope);

  if (!known) {
    scopes.add(scope);
    getInspectorScopeId(scope);
  }

  if (!enabled || known) {
    return;
  }

  emit({ type: "scope-created", scope });
}

export function prepareInspectorSnapshotNode(node: Node, prepare: () => void): void {
  snapshotPreparers.set(node, prepare);
}

export function linkInspectorNodes(
  source: Node,
  target: Node,
  options: {
    kind?: InspectorEdgeKind;
    role?: string;
  } = {},
): void {
  const kind = options.kind ?? "owner";

  registerInspectorNode(source);
  registerInspectorNode(target);

  if (
    nodeLinks.some((link) => link.source === source && link.target === target && link.kind === kind)
  ) {
    return;
  }

  nodeLinks.push({
    source,
    target,
    kind,
    role: options.role,
  });

  if (kind === "owner" && options.role) {
    nodeParents.set(target, {
      parent: source,
      role: options.role,
    });
  }

  if (enabled) {
    emit({ type: "node-created", node: source });
  }
}

export function emitInspectorNodeStart(
  event: Omit<Extract<InspectorEvent, { type: "node-start" }>, "type">,
): void {
  if (!enabled) {
    return;
  }

  registerInspectorNode(event.node);
  registerInspectorScope(event.scope);
  emit({ ...event, type: "node-start" });
}

export function emitInspectorNodeEnd(
  event: Omit<Extract<InspectorEvent, { type: "node-end" }>, "type">,
): void {
  if (!enabled) {
    return;
  }

  registerInspectorNode(event.node);
  registerInspectorScope(event.scope);
  emit({ ...event, type: "node-end" });
}

export function emitInspectorBreakpointHit(
  event: Omit<Extract<InspectorEvent, { type: "breakpoint-hit" }>, "type">,
): void {
  if (!enabled) {
    return;
  }

  registerInspectorNode(event.node);
  registerInspectorScope(event.scope);
  emit({ ...event, type: "breakpoint-hit" });
}

export function shouldStopAfterInspectorNode(node: Node): boolean {
  return enabled && breakpoints.has(getInspectorNodeId(node));
}

export function setInspectorBreakpoints(ids: Iterable<string>): void {
  breakpoints.clear();

  for (const id of ids) {
    breakpoints.add(id);
  }
}

export function getInspectorBreakpoints(): string[] {
  return [...breakpoints];
}

export function getInspectorNodeId(node: Node): string {
  let id = nodeIds.get(node);

  if (!id) {
    id = `node:${++nextNodeId}`;
    nodeIds.set(node, id);
    nodeById.set(id, node);
  }

  return id;
}

export function getInspectorScopeId(scope: Scope): string {
  let id = scopeIds.get(scope);

  if (!id) {
    id = `scope:${++nextScopeId}`;
    scopeIds.set(scope, id);
    scopeById.set(id, scope);
  }

  return id;
}

export function getInspectorNodeById(id: string): Node | undefined {
  return nodeById.get(id);
}

export function getInspectorScopeById(id: string): Scope | undefined {
  return scopeById.get(id);
}

export function readInspectorNodeMeta(node: Node): InspectorNodeMeta {
  return readInspectorNodeMetaFromRecord(node.meta);
}

/**
 * Human-readable label for a node, used in error messages and diagnostics.
 * Prefers the annotated unit name (`store "$user"`), falling back to the type
 * plus the stable inspector id (`event #12`) so the unit can still be located
 * in devtools even when it was never explicitly named.
 */
export function describeNode(node: Node): string {
  const meta = readInspectorNodeMeta(node);
  const type = meta.type ?? "unit";

  return meta.name
    ? `${type} "${meta.name}"`
    : `${type} ${getInspectorNodeId(node).replace("node:", "#")}`;
}

export function getInspectorSnapshot(): InspectorSnapshot {
  for (const node of Array.from(nodes)) {
    snapshotPreparers.get(node)?.();
  }

  for (const node of Array.from(nodes)) {
    for (const next of node.next ?? []) {
      registerInspectorNode(next);
    }
  }

  const visibleNodes = dedupeNamedNodes(
    [...nodes].filter((node) => !readInspectorNodeMeta(node).internal),
  );
  const visibleNodeSet = new Set(visibleNodes);
  const snapshotNodes = visibleNodes.map((node) => {
    const id = getInspectorNodeId(node);
    const meta = readInspectorNodeMeta(node);
    const type = meta.type ?? "node";
    const parent = nodeParents.get(node);
    const parentId =
      parent && visibleNodeSet.has(parent.parent) ? getInspectorNodeId(parent.parent) : undefined;
    const parentRole = parentId && parent ? parent.role : undefined;

    return {
      id,
      name: meta.name ?? `${type} ${id.replace("node:", "#")}`,
      type,
      key: meta.key ?? false,
      callable: meta.callable ?? false,
      writable: meta.writable ?? false,
      internal: meta.internal ?? false,
      parentId,
      parentRole,
      meta,
    } satisfies InspectorNodeSnapshot;
  });
  const edges: InspectorEdgeSnapshot[] = [];
  const edgeIds = new Set<string>();

  const addEdge = (sourceNode: Node, targetNode: Node, kind: InspectorEdgeKind): void => {
    const source = getInspectorNodeId(sourceNode);
    const target = getInspectorNodeId(targetNode);
    const id = `${kind}:${source}->${target}`;

    if (!edgeIds.has(id)) {
      edgeIds.add(id);
      edges.push({ id, source, target, kind });
    }
  };

  for (const node of visibleNodes) {
    for (const next of flattenVisibleNextNodes(node, visibleNodeSet)) {
      addEdge(node, next, "reactive");
    }
  }

  for (const link of nodeLinks) {
    if (visibleNodeSet.has(link.source) && visibleNodeSet.has(link.target)) {
      addEdge(link.source, link.target, link.kind);
    }
  }

  return {
    nodes: snapshotNodes,
    edges,
    scopes: [...scopes].map((scope) => {
      const id = getInspectorScopeId(scope);

      return {
        id,
        name: scopeMeta.get(scope)?.name ?? `scope ${id.replace("scope:", "#")}`,
      };
    }),
    breakpoints: getInspectorBreakpoints().filter((id) =>
      snapshotNodes.some((node) => node.id === id),
    ),
  };
}

function dedupeNamedNodes(input: Node[]): Node[] {
  const latestByKey = new Map<string, Node>();
  const keys = new WeakMap<Node, string>();

  for (const node of input) {
    const meta = readInspectorNodeMeta(node);

    if (!meta.name) {
      continue;
    }

    const key = `${meta.type ?? "node"}:${meta.name}`;

    keys.set(node, key);
    latestByKey.set(key, node);
  }

  return input.filter((node) => {
    const key = keys.get(node);

    return !key || latestByKey.get(key) === node;
  });
}

function flattenVisibleNextNodes(node: Node, visibleNodes: Set<Node>): Node[] {
  const result: Node[] = [];
  const visited = new Set<Node>();

  for (const next of node.next ?? []) {
    visit(next);
  }

  return result;

  function visit(next: Node): void {
    if (visited.has(next)) {
      return;
    }

    visited.add(next);

    if (visibleNodes.has(next)) {
      result.push(next);
      return;
    }

    for (const nested of next.next ?? []) {
      visit(nested);
    }
  }
}

export function inspectorNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function readInspectorNodeMetaFromRecord(
  meta: Record<string, unknown> | undefined,
): InspectorNodeMeta {
  const inspector = meta?.[inspectorMetaKey];

  if (!inspector || typeof inspector !== "object") {
    return {};
  }

  return inspector as InspectorNodeMeta;
}

function emit(event: InspectorEvent): void {
  if (!enabled) {
    return;
  }

  for (const listener of listeners) {
    listener(event);
  }
}

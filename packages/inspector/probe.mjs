import { createEffect } from "effector";

const fx = createEffect({ name: "myFx", handler: async (x) => x });
const g = fx.graphite;

const live = new Map();
const stack = [g];
while (stack.length) {
  const node = stack.pop();
  const id = String(node.id);
  if (live.has(id)) continue;
  live.set(id, node);
  for (const n of node.next) stack.push(n);
  for (const l of node.family.links) stack.push(l);
  for (const o of node.family.owners) stack.push(o);
}

console.log("=== ALL NODES ===");
for (const [id, node] of live) {
  const m = node.meta;
  console.log(`id=${id} op=${m.op} name=${m.name} named=${m.named} derived=${m.derived}`);
}

const UNIT_OPS = new Set(["store","event","effect"]);
const isUnitOp = (op) => op !== undefined && UNIT_OPS.has(op);
function classify(meta){
  const op = meta.op;
  const derived = Boolean(meta.derived);
  const unit = isUnitOp(op);
  return { type: op ?? "node", key: unit && !derived, internal: !unit, derived };
}

const visible = new Map();
for (const [id, node] of live) {
  const c = classify(node.meta);
  if (c.internal) continue;
  visible.set(id, { id, name: node.meta.name ?? node.meta.op, ...c, named: node.meta.named, derived: node.meta.derived });
}
console.log("\n=== VISIBLE NODES ===");
for (const [id, v] of visible) {
  console.log(`id=${id} name=${v.name} type=${v.type} key=${v.key} named=${v.named} derived=${v.derived}`);
}

// Reproduce flattenVisible for owners direction
function neighbors(node, direction){ return direction === "next" ? node.next : node.family.owners; }
function flattenVisible(start, direction){
  const result = new Set();
  const seen = new Set();
  const stack = [...neighbors(start, direction)];
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    const id = String(node.id);
    if (visible.has(id)) { result.add(id); continue; }
    if (!live.has(id)) continue;
    for (const nb of neighbors(node, direction)) stack.push(nb);
  }
  return [...result];
}

console.log("\n=== OWNER EDGES (replicating graph.ts lines 242-251) ===");
const parents = new Map();
const ownerEdges = [];
for (const id of visible.keys()) {
  const node = live.get(id);
  const meta = node.meta;
  if (meta.derived && typeof meta.named === "string") {
    const owners = flattenVisible(node, "owners");
    for (const owner of owners) {
      ownerEdges.push([owner, id]);
    }
    if (owners.length && !parents.has(id)) {
      parents.set(id, { parentId: owners[0], role: meta.named });
    }
  }
}
const nm = (id) => { const n = visible.get(id); return n ? (n.name+"/"+n.type) : id; };
for (const [src, tgt] of ownerEdges) {
  console.log(`owner edge: ${nm(src)} (${src}) -> ${nm(tgt)} (${tgt})`);
}
console.log("\n=== PARENTS ===");
for (const [id, p] of parents) {
  console.log(`${nm(id)} (${id}) parentId=${nm(p.parentId)} (${p.parentId}) role=${p.role}`);
}

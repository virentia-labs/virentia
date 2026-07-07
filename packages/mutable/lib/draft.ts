// Copy-on-write draft — no `structuredClone`, no stored snapshots.
//
// `.value` hands out a draft over the scope's current committed tree. Reading
// descends into child drafts (created lazily, only for nodes the user actually
// touches); the original tree is never touched. On the first write into a node
// it is shallow-copied (only that node), and the copy replaces it up the parent
// chain, so untouched branches stay shared by reference. Nodes the scope already
// owns (copies it made in an earlier commit) are mutated in place instead of
// copied again. At commit the draft's latest tree becomes the scope's committed
// value — see `mutable-store.ts`.
//
// Every node is one small `DraftState` (a class, for a stable hidden class) plus
// one Proxy over a fresh `[]`/`{}` target that carries the state under a symbol,
// read in the shared handler as a plain property — no per-node closures and no
// side WeakMap. A fresh real target keeps array `length`/index and enumeration
// invariants valid and array mutators native.
//
// The draft also drives fine-grained reactivity: while something is tracking
// (see `env.isTracking`) each read reports the keypath it touched through
// `env.onRead`, and each write reports the keypath it changed through
// `env.onChange`. The store maps keypaths to graph nodes so a reader only
// re-runs when a path it read is written. Reads report every prefix of a path
// (a get walks parent→child), so replacing an ancestor invalidates deep readers;
// writes report the exact path, so a sibling edit does not.

const ARRAY_MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

const STATE = Symbol("virentia.mutable.state");

// Separates keys in a path string. A control char never occurs in normal keys,
// so a flat string is a cheap, near-collision-free identity for a keypath.
const SEP = "\u0001";

/**
 * Environment shared by every node of one draft tree (passed by reference, so a
 * node holds a single pointer instead of a copy of each hook).
 */
export interface DraftEnv {
  /** Nodes this scope already copied — mutate in place instead of copying again. */
  owned: WeakSet<object>;
  /** Report a write at `path` (the exact keypath that changed). */
  onChange: (path: string) => void;
  /** Report a read of `path` (a keypath, or `""` for the root). No-op unless tracking. */
  onRead: (path: string) => void;
  /** Report a read of the whole value (`unwrap`) — a coarse dependency on any commit. */
  onReadAll: () => void;
  /** Whether a read should register as a dependency right now. */
  isTracking: () => boolean;
}

class DraftState {
  copy: object | null = null;
  children: Map<PropertyKey, DraftState> | null = null;
  proxy!: object;
  private _path: string | undefined;

  constructor(
    public base: object,
    public parent: DraftState | null,
    public key: PropertyKey,
    public env: DraftEnv,
    public isArray: boolean,
  ) {}

  // The node's keypath from the root (`""`). Built lazily and cached — only ever
  // needed while tracking, so a plain mutation never pays for it.
  get path(): string {
    return (this._path ??= this.parent ? this.parent.path + SEP + String(this.key) : "");
  }
}

const stateOf = (target: object): DraftState => (target as Record<symbol, DraftState>)[STATE];

export function isDraftable(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The raw object behind a draft proxy (its current copy/base), else the value. */
export function unwrap<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  const state = (value as Record<symbol, DraftState | undefined>)[STATE];
  return state ? (latest(state) as T) : value;
}

const latest = (state: DraftState): object => state.copy ?? state.base;

const shallowCopy = <T extends object>(value: T): T =>
  (Array.isArray(value) ? value.slice() : { ...value }) as T;

// Ensure this node is writable: owned nodes are mutated in place; shared nodes
// are copied and the copy is threaded up the parent chain (copy-on-write).
function ensureWritable(state: DraftState): object {
  if (state.copy) return state.copy;

  const copy = state.env.owned.has(state.base) ? state.base : shallowCopy(state.base);
  state.copy = copy;
  state.env.owned.add(copy);

  if (state.parent) {
    (ensureWritable(state.parent) as Record<PropertyKey, unknown>)[state.key] = copy;
  }

  return copy;
}

function childState(state: DraftState, key: PropertyKey, value: object): DraftState {
  let children = state.children;
  if (children) {
    const existing = children.get(key);
    if (existing && existing.base === value) return existing;
  } else {
    children = new Map();
    state.children = children;
  }

  const child = createDraft(value, state, key, state.env);
  children.set(key, child);
  return child;
}

// One handler for every draft node; state comes from the (unique) target.
const handler: ProxyHandler<object> = {
  get(target, property) {
    const state = stateOf(target);

    if (property === STATE) {
      // `unwrap` reaches the whole subtree — a coarse dependency on any commit.
      if (state.env.isTracking()) state.env.onReadAll();
      return state;
    }

    const source = latest(state) as Record<PropertyKey, unknown>;

    if (state.isArray && typeof property === "string" && ARRAY_MUTATORS.has(property)) {
      return (...args: unknown[]): unknown => {
        const array = ensureWritable(state) as unknown as Record<
          string,
          (...a: unknown[]) => unknown
        >;
        state.children = null;
        const result = array[property](...args.map(unwrap));
        // A structural change to the array — reported at the array's own path, so
        // anyone who read through it (any index, `.length`, iteration) re-runs.
        state.env.onChange(state.path);
        return result;
      };
    }

    // Reading a property depends on that keypath. Descending to a child reports
    // the child's path too, so a reader of `a.b.c` is subscribed to `a`, `a.b`,
    // and `a.b.c` — replacing any of them re-runs it.
    if (typeof property === "string" && state.env.isTracking()) {
      state.env.onRead(state.path + SEP + property);
    }

    const value = source[property];
    return isDraftable(value) ? childState(state, property, value).proxy : value;
  },

  set(target, property, value) {
    const state = stateOf(target);
    const writable = ensureWritable(state) as Record<PropertyKey, unknown>;
    const isNew = !(property in writable);
    writable[property] = unwrap(value);
    state.children?.delete(property);

    if (typeof property === "string") {
      state.env.onChange(state.path + SEP + property);
      // A new key changes the node's shape — invalidate readers that enumerated it.
      if (isNew) state.env.onChange(state.path);
    } else {
      state.env.onChange(state.path);
    }
    return true;
  },

  deleteProperty(target, property) {
    const state = stateOf(target);
    const writable = ensureWritable(state) as Record<PropertyKey, unknown>;
    const existed = property in writable;
    delete writable[property];
    state.children?.delete(property);

    if (typeof property === "string") {
      state.env.onChange(state.path + SEP + property);
      if (existed) state.env.onChange(state.path);
    } else {
      state.env.onChange(state.path);
    }
    return true;
  },

  has(target, property) {
    const state = stateOf(target);
    // Presence depends on the node's shape — a structural (whole-node) read.
    if (state.env.isTracking()) state.env.onRead(state.path);
    return property in (latest(state) as object);
  },

  ownKeys(target) {
    const state = stateOf(target);
    if (state.env.isTracking()) state.env.onRead(state.path);
    return Reflect.ownKeys(latest(state));
  },

  getOwnPropertyDescriptor(target, property) {
    return Reflect.getOwnPropertyDescriptor(latest(stateOf(target)), property);
  },
};

function createDraft(
  base: object,
  parent: DraftState | null,
  key: PropertyKey,
  env: DraftEnv,
): DraftState {
  const state = new DraftState(base, parent, key, env, Array.isArray(base));
  const target = (state.isArray ? [] : {}) as Record<symbol, unknown>;
  target[STATE] = state;
  state.proxy = new Proxy(target, handler);
  return state;
}

export interface Draft {
  readonly proxy: object;
  latest(): object;
  readonly modified: boolean;
}

/** Open a draft over `base` for a scope (see `DraftEnv`). */
export function createRootDraft(base: object, env: DraftEnv): Draft {
  const state = createDraft(base, null, "", env);

  return {
    proxy: state.proxy,
    latest: () => latest(state),
    get modified() {
      return state.copy !== null;
    },
  };
}

// DOM handlers are retained by the selected renderer or browser producer.
import { scoped, type Scope } from "@virentia/core";
import {
  node, runDetached, getActiveScope, isTracking, unwrapMicroScope, trackNode,
  sequenceBindingOf, isModelInstance, isModelDefinition, type SequenceOperation,
} from "@virentia/core/internal";
import type { InstanceApi, ModelDefinition } from "@virentia/core/models";
import { componentMetadataOf } from "./component";
import { rowView, listKeyPaths, forItems, type ForProps, type RowValues } from "./builtin-descriptions";
import {
  ChildPath, bind, region, regionParent, finishRegion, childContext, runIn, mount,
  mountModelRow, insert, mountWork, readBinding, htmlNamespace, isReadable,
  type Parent, type Props, type UIContext,
} from "./native-runtime";
import { closeLifetimesClearing, disposeLifetime, ownCleanup } from "./lifetime";
import type { Child, Component } from "./types";

/** A row is the contiguous range of its content's top-level nodes. */
export interface Row<T> extends RowValues<T> {
  start: Node;
  end: Node;
  context: UIContext;
  hydrating?: boolean;
}

export function warnListReset(): void {
  const env = (import.meta as { env?: { DEV?: boolean } }).env;
  const nodeEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
    ?.NODE_ENV;
  if (env?.DEV === false || nodeEnv === "production") return;
  console.warn(
    "[ui] For received a whole-array replacement. Its rows are recreated without reconciliation. Use a mutableStore array's mutation methods or a model collection/query for in-place list updates.",
  );
}

/** Arrays of rows, edited only by source operations. No key matching or tree diff. */
export function mountList<T>(
  props: ForProps<T>,
  parent: Parent,
  before: Node | null,
  ctx: UIContext,
): void {
  const target = region(parent, before, ctx);
  const rows: Row<T>[] = [];
  const path = listKeyPaths();
  let fallback: UIContext | undefined;
  let hasIndexUnits = false;
  const notify = (row: Row<T>) => {
    if (row.readers) for (const scope of row.readers) runDetached({ unit: row.changed!, scope });
  };
  const updateIndices = () => {
    if (!hasIndexUnits) return;
    rows.forEach((row, index) => {
      if (row.index === index) return;
      row.index = index;
      notify(row);
    });
  };
  const createRow = (item: T, index: number, anchor: Node): Row<T> => {
    const currentParent = regionParent(target, parent);
    const segment = path(isModelInstance(item) ? (item as InstanceApi).id : {});
    if (target.context.root.hydration?.active) {
      // Server rows carry region markers; claim them as the row's range.
      const owned = region(currentParent, anchor, target.context, segment);
      const row: Row<T> = { ...owned, item, index };
      try {
        runIn(row.context, () => mount(rowView(props, row), currentParent, row.end, row.context));
      } catch (error) {
        void row.context.owner.dispose();
        throw error;
      }
      if (row.indexUnit) hasIndexUnits = true;
      finishRegion(row, currentParent);
      return row;
    }
    // Client rows need no markers: a row's first and last top-level nodes are
    // stable for its lifetime (elements and text bindings are patched in place,
    // nested regions keep their own markers). Only an empty row gets one.
    const view = props.view;
    const metadata = view ? componentMetadataOf(view as Component<any>) : undefined;
    const modelRow = metadata !== undefined && isModelInstance(item);
    const context = childContext(target.context, segment);
    if (modelRow) {
      // The row's frame holds only its component's: one frame is both, with
      // the component's path and depth and the row's lifetime.
      context.path = new ChildPath(context.path, 0);
      context.depth++;
    }
    const row: Row<T> = { start: anchor, end: anchor, context, item, index };
    const previous = anchor.previousSibling;
    try {
      if (modelRow)
        mountModelRow(
          view as Component<any>,
          metadata,
          item as InstanceApi,
          currentParent,
          anchor,
          context,
        );
      else runIn(context, () => mount(rowView(props, row), currentParent, anchor, context));
    } catch (error) {
      void context.owner.dispose();
      throw error;
    }
    const first = previous ? previous.nextSibling! : currentParent.firstChild!;
    if (first === anchor) {
      const placeholder = context.document!.createComment("ui");
      insert(placeholder, currentParent, anchor, context);
      row.start = row.end = placeholder;
    } else {
      row.start = first;
      row.end = anchor.previousSibling!;
    }
    if (row.indexUnit) hasIndexUnits = true;
    return row;
  };
  const showFallback = () => {
    if (rows.length) {
      if (fallback) {
        void fallback.owner.dispose();
        fallback = undefined;
      }
      return;
    }
    if (!fallback && props.fallback !== undefined) {
      fallback = childContext(target.context, "empty");
      runIn(fallback, () =>
        mount(props.fallback, regionParent(target, parent), target.end, fallback!),
      );
    }
  };
  // Every row leaves and the list is all its parent holds: the parent is
  // emptied once, not one removal per row. Rows of disposed model instances
  // closed already, their nodes waiting for the end of the bulk removal; other
  // rows close here as one teardown.
  const clearRows = (removed: Row<T>[]): boolean => {
    const host = regionParent(target, parent);
    const root = target.context.root;
    if (
      root.hydration?.active ||
      root.hydration?.failed ||
      host.firstChild !== target.start ||
      host.lastChild !== target.end ||
      removed[0].start !== target.start.nextSibling ||
      removed[removed.length - 1].end !== target.end.previousSibling
    )
      return false;
    const clear = () => {
      host.textContent = "";
      host.appendChild(target.start);
      host.appendChild(target.end);
    };
    if (root.removals && removed.every((row) => row.context.owner.closed)) {
      clear();
      return true;
    }
    return closeLifetimesClearing(
      removed.map((row) => row.context.owner),
      host,
      clear,
    );
  };
  let warned = false;
  const warn = () => {
    if (!warned) {
      warned = true;
      warnListReset();
    }
  };
  const disposeRows = (removed: Row<T>[]): Promise<void> | undefined => {
    if (removed.length > 1 && !rows.length && clearRows(removed)) return;
    const pending = removed.map((row) => disposeLifetime(row.context.owner));
    return removed.some((row) => !row.context.owner.closed)
      ? Promise.all(pending).then(() => {})
      : undefined;
  };
  const execute = (op: SequenceOperation<T>): void | Promise<void> => {
    switch (op.type) {
      case "insert": {
        const anchor = rows[op.index]?.start ?? target.end;
        if (op.items.length === 1) {
          const row = createRow(op.items[0], op.index, anchor);
          if (op.index === rows.length) rows.push(row);
          else rows.splice(op.index, 0, row);
          break;
        }
        const created = op.items.map((item, offset) => createRow(item, op.index + offset, anchor));
        rows.splice(op.index, 0, ...created);
        break;
      }
      case "remove": {
        const removed = rows.splice(op.index, op.count);
        return disposeRows(removed);
      }
      case "move": {
        const moved = rows.splice(op.from, op.count);
        rows.splice(op.to, 0, ...moved);
        const anchor = rows[op.to + moved.length]?.start ?? target.end;
        for (const row of moved)
          moveRange(row.start, row.end, regionParent(target, parent), anchor, ctx.document!);
        break;
      }
      case "reorder": {
        const previous = rows.slice();
        rows.splice(0, rows.length, ...op.order.map((index) => previous[index]));
        let anchor: Node = target.end;
        for (let index = rows.length - 1; index >= 0; index--) {
          const row = rows[index];
          moveRange(row.start, row.end, regionParent(target, parent), anchor, ctx.document!);
          anchor = row.start;
        }
        break;
      }
      case "update": {
        const row = rows[op.index];
        if (row) {
          row.item = op.item;
          notify(row);
        }
        break;
      }
      case "replace": {
        const previous = rows[op.index];
        const anchor = rows[op.index + 1]?.start ?? target.end;
        const attach = () => {
          rows[op.index] = createRow(op.item, op.index, anchor);
        };
        const pending = previous && disposeRows([previous]);
        if (pending) return pending.then(() => mountWork(target.context, attach));
        attach();
        break;
      }
      case "reset": {
        warn();
        const pending = disposeRows(rows.splice(0));
        const attach = () => {
          op.items.forEach((item, index) => rows.push(createRow(item, index, target.end)));
        };
        if (pending) return pending.then(() => mountWork(target.context, attach));
        attach();
        break;
      }
    }
  };
  // One batch at a time: the operations of the batch in progress, and the next.
  const batches: (readonly SequenceOperation<T>[])[] = [];
  let busy = false;
  let batch: readonly SequenceOperation<T>[] = [];
  let next = 0;
  const run = (): void => {
    if (target.context.owner.closing) {
      batches.length = 0;
      busy = false;
      return;
    }
    while (next < batch.length) {
      const pending = execute(batch[next++]);
      if (pending) {
        void pending.then(drain, (error) => {
          target.context.root.errors.push(error);
          drain();
        });
        return;
      }
    }
    updateIndices();
    showFallback();
    step();
  };
  const drain = (): void => mountWork(target.context, run);
  const step = (): void => {
    if (target.context.owner.closing) {
      batches.length = 0;
      busy = false;
      return;
    }
    const following = batches.shift();
    if (!following) {
      busy = false;
      return;
    }
    batch = following;
    next = 0;
    drain();
  };
  const apply = (operations: readonly SequenceOperation<T>[]): void => {
    batches.push(operations);
    if (busy) return;
    busy = true;
    step();
  };
  const source: ForProps<T>["each"] = isModelDefinition(props.each)
    ? (scoped(
        ctx.root.scope,
        () => (props.each as ModelDefinition).instances,
      ) as unknown as Iterable<T>)
    : props.each;
  const edits = sequenceBindingOf<T>(source);
  if (edits) {
    if (edits.scope && edits.scope !== ctx.root.scope && edits.scope !== ctx.scope)
      throw new Error("[ui] For source belongs to a different render scope");
    const items = edits.snapshot();
    if (
      isReadable(source) &&
      (source as { writable?: boolean }).writable === true &&
      items.some(isModelInstance)
    )
      throw new TypeError("[ui] Model instances belong in Core model containers, not a mutableStore array");
    items.forEach((item, index) => rows.push(createRow(item, index, target.end)));
    ownCleanup(target.context.owner, edits.subscribe(apply));
  } else if (
    isReadable(source) ||
    typeof source === "function" ||
    (typeof source === "object" && source !== null && "items" in source)
  ) {
    let initialized = false;
    bind(
      target.context,
      () => forItems<T>(source as ForProps<T>["each"], ctx.scope),
      (items) => {
        if (!initialized) {
          initialized = true;
          items.forEach((item, index) => rows.push(createRow(item, index, target.end)));
        } else apply([{ type: "reset", items }]);
      },
    );
    // Warn at mount too: computed arrays never carry a mutation stream.
    warn();
  } else {
    forItems(source, ctx.scope).forEach((item, index) =>
      rows.push(createRow(item, index, target.end)),
    );
  }
  showFallback();
  finishRegion(target, parent);
}

export function moveRange(start: Node, end: Node, parent: Parent, before: Node, document: Document): void {
  if (end.nextSibling === before) return;
  const focused = document.activeElement as HTMLElement | null;
  let restoresFocus = false;
  let current: Node | null = start;
  while (current) {
    const next: Node | null = current.nextSibling;
    if (focused && (current === focused || current.contains(focused))) restoresFocus = true;
    parent.insertBefore(current, before);
    if (current === end) break;
    current = next;
  }
  if (restoresFocus && focused && document.activeElement !== focused)
    focused.focus({ preventScroll: true });
}
export function mountProvider(props: Props, parent: Parent, before: Node | null, ctx: UIContext): void {
  const child = childContext(ctx);
  const values = new Map(ctx.values);
  const changed = node();
  const readers = new Set<Scope>();
  let current: unknown;
  bind(
    child,
    () => readBinding(props.value),
    (next) => {
      if (Object.is(current, next)) return;
      current = next;
      for (const scope of readers) runDetached({ unit: changed, scope });
    },
  );
  ownCleanup(child.owner, () => readers.clear());
  values.set(props.id as symbol, () => {
    const active = getActiveScope();
    if (active && isTracking()) readers.add(unwrapMicroScope(active));
    trackNode(changed);
    return current;
  });
  child.values = values;
  runIn(child, () => mount(props.children as Child, parent, before, child));
}

export function mountPortal(props: Props, parent: Parent, before: Node | null, ctx: UIContext): void {
  const target = props.mount as Parent;
  if (!target || typeof target.insertBefore !== "function")
    throw new Error("[ui] Portal requires a DOM mount target");
  const child = childContext(ctx);
  child.document = target.ownerDocument;
  child.namespace =
    target.nodeType === 1 ? ((target as Element).namespaceURI ?? htmlNamespace) : htmlNamespace;
  runIn(child, () => mount(props.children as Child, target, null, child));
}

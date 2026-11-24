// A removal of several instances disposes them one by one. A renderer can hold
// back work it would otherwise repeat for each of them (detaching DOM rows)
// until all are gone and the collection delivered its changes.
let depth = 0;
let tasks: (() => void)[] | undefined;

/** @internal Run `task` once the bulk removal in progress ends; `false` when none runs. */
export function afterBulkRemoval(task: () => void): boolean {
  if (depth === 0) return false;
  (tasks ??= []).push(task);
  return true;
}

/** Run `remove` as a bulk removal: tasks queued during it run right after it, even if it throws. */
export function bulkRemoval<T>(remove: () => T): T {
  depth++;
  try {
    return remove();
  } finally {
    if (--depth === 0 && tasks) {
      const queued = tasks;
      tasks = undefined;
      let failed = false;
      let failure: unknown;
      for (const task of queued)
        try {
          task();
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      // oxlint-disable-next-line no-unsafe-finally -- a failed task must not pass silently
      if (failed) throw failure;
    }
  }
}

import { createPage, currentPage, readPageContext, setCurrentPage, writePageContext } from "./run";
import type { KernelContext, KernelContextManager } from "./types";

export function context<T>(): KernelContextManager<T> {
  const id = Symbol();

  return {
    id,

    setup(value: T): KernelContext<T> {
      return { id, value };
    },

    has(): boolean {
      let cursor: ReturnType<typeof createPage> | null = currentPage;

      while (cursor) {
        if (cursor.contextMap.has(id)) return true;
        cursor = cursor.parent;
      }

      return false;
    },

    set(value: T): void {
      writePageContext(currentPage, id, value);
    },

    get(fallback?: T): T {
      return readPageContext(currentPage, id, fallback);
    },

    delete(): void {
      currentPage.contextMap.delete(id);
    },
  };
}

function withPage<T>(page: ReturnType<typeof createPage>, fn: () => T): T {
  const previousPage = currentPage;

  setCurrentPage(page);

  try {
    return fn();
  } finally {
    setCurrentPage(previousPage);
  }
}

export function withContexts<T>(contexts: Iterable<KernelContext>, fn: () => T): T {
  return withPage(createPage({ parent: currentPage, contexts }), fn);
}

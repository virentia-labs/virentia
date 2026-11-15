import { scope, scoped, type Scope } from "@virentia/core";
import { test as base } from "vitest";
import { hydrate, lifetime, render } from "../../lib/runtime";
import type { Child } from "../../lib/types";

/** Project-local Vitest fixture, not a library API or a test runner wrapper. */
interface DOMFixture {
  readonly scope: Scope;
  readonly document: Document;
  readonly container: HTMLDivElement;
  render(factory: () => Child): Promise<void>;
  hydrate(factory: () => Child, html: string): Promise<void>;
  run<T>(callback: () => T): T;
}

export const test = base.extend<{ root: DOMFixture }>({
  root: async ({}, use) => {
    const appScope = scope();
    const page = document.implementation.createHTMLDocument("UI regression test");
    const container = page.createElement("div");
    page.body.append(container);
    const owner = lifetime();
    let unmount: (() => Promise<void>) | undefined;
    try {
      await use({
        scope: appScope,
        document: page,
        container,
        async render(factory) {
          if (unmount) await unmount();
          unmount = render(factory, container, { scope: appScope, owner, identifierPrefix: "test" });
        },
        async hydrate(factory, html) {
          if (unmount) await unmount();
          container.innerHTML = html;
          unmount = hydrate(factory, container, { scope: appScope, owner, identifierPrefix: "test" });
        },
        run: (callback) => scoped(appScope, callback),
      });
    } finally {
      await owner.dispose();
    }
  },
});

export const it = test;

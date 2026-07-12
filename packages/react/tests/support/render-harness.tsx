import { render, screen } from "@testing-library/react";
import { act, Component, createElement, type ReactNode } from "react";
import { vi } from "vitest";
import { scoped, type Scope } from "@virentia/core";
import { ScopeProvider } from "../../lib";

export function renderWithScope(appScope: Scope, element: ReactNode) {
  return render(createElement(ScopeProvider, { scope: appScope }, element));
}

export function withScope(appScope: Scope, element: ReactNode): ReactNode {
  return createElement(ScopeProvider, { scope: appScope }, element);
}

export function button() {
  return screen.getByRole("button");
}

export function readIn<T>(sc: Scope, fn: () => T): T {
  return scoped(sc, fn);
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class ErrorBoundary extends Component<
  { onError: (error: Error) => void; children?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// Runs `render` and drives an interaction that is expected to violate the
// Rules-of-Hooks. React reports the error to the nearest error boundary (so
// `act` may not rethrow); we surface whichever error was produced.
export async function captureHookError(
  click: () => void,
  errors: Error[],
): Promise<Error[]> {
  const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
  let thrown: Error | null = null;
  try {
    await act(async () => {
      click();
    });
  } catch (error) {
    thrown = error as Error;
  }
  consoleErr.mockRestore();
  return thrown ? [...errors, thrown] : errors;
}

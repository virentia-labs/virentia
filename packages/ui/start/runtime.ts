import { scope, serialize, type JsonValue, type Scope, type ScopeSnapshot } from "@virentia/core";
import { hydrate } from "../lib/runtime";
import { renderToString, renderToStringAsync } from "../lib/server";
import type { Child } from "../lib/types";

export interface PagePayload<Data> {
  readonly data: Data;
  readonly snapshot: ScopeSnapshot;
  readonly identifierPrefix: string;
}

export interface RenderedPage {
  readonly html: string;
  /** Escaped JSON text for a `<script type="application/json">` element. */
  readonly payload: string;
}

export interface HydratedPage<Data> {
  readonly data: Data;
  readonly scope: Scope;
  readonly dispose: () => Promise<void>;
}

/** Render one request with its own Core scope and a hydration payload. */
export function renderPage<Data>(
  view: (data: Data) => Child,
  data: Data,
  options: { identifierPrefix: string },
): RenderedPage {
  const request = preparePage(view, data, options);
  return finishPage(renderToString(request.view, request), request);
}

/** Await foreign SSR before capturing the request's final hydration state. */
export async function renderPageAsync<Data>(
  view: (data: Data) => Child,
  data: Data,
  options: { identifierPrefix: string },
): Promise<RenderedPage> {
  const request = preparePage(view, data, options);
  const html = await renderToStringAsync(request.view, request);
  return finishPage(html, request);
}

interface PageRequest {
  readonly data: JsonValue;
  readonly identifierPrefix: string;
  readonly scope: Scope;
  readonly view: () => Child;
}

function preparePage<Data>(
  view: (data: Data) => Child,
  data: Data,
  options: { identifierPrefix: string },
): PageRequest {
  const identifierPrefix = validatePrefix(options?.identifierPrefix);
  const payloadData = cloneJson(data, "data", new Set());
  return {
    data: payloadData,
    scope: scope(),
    identifierPrefix,
    view: () => view(cloneJson(payloadData, "data", new Set()) as Data),
  };
}

function finishPage(html: string, request: PageRequest): RenderedPage {
  const snapshot = serialize(request.scope);
  const payload = escapeForScript(
    JSON.stringify({ data: request.data, snapshot, identifierPrefix: request.identifierPrefix }),
  );
  return { html, payload };
}

/** Restore server data and state before attaching bindings to the existing DOM. */
export function hydratePage<Data>(
  view: (data: Data) => Child,
  container: Element | DocumentFragment,
  payloadText: string,
): HydratedPage<Data> {
  const parsed: unknown = JSON.parse(payloadText);
  if (!isPlainRecord(parsed) || !Object.hasOwn(parsed, "data")) {
    throw new TypeError("[ui/start] Invalid page payload: missing data");
  }
  const identifierPrefix = validatePrefix(parsed.identifierPrefix);
  const snapshot = parsed.snapshot;
  if (!isPlainRecord(snapshot)) {
    throw new TypeError("[ui/start] Invalid page payload: snapshot must be a record");
  }
  const clientScope = scope({ snapshot: snapshot as ScopeSnapshot });
  const data = parsed.data as Data;
  const dispose = hydrate(() => view(data), container, {
    scope: clientScope,
    identifierPrefix,
  });
  return { data, scope: clientScope, dispose };
}

function validatePrefix(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("[ui/start] identifierPrefix must be a non-empty string");
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function escapeForScript(value: string): string {
  return value.replace(/[<>&\u2028\u2029]/g, (character) => {
    switch (character) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      default:
        return "\\u2029";
    }
  });
}

function cloneJson(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (typeof value !== "object") {
    throw new TypeError(`[ui/start] Cannot serialize ${path}: unsupported ${typeof value} value`);
  }
  if (ancestors.has(value))
    throw new TypeError(`[ui/start] Cannot serialize ${path}: cyclic value`);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`[ui/start] Cannot serialize ${path}: expected a plain JSON object`);
  }
  ancestors.add(value);
  try {
    const result: JsonValue[] | Record<string, JsonValue> = array ? [] : Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) {
      throw new TypeError(`[ui/start] Cannot serialize ${path}: sparse arrays are unsupported`);
    }
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") {
        throw new TypeError(`[ui/start] Cannot serialize ${path}: symbol keys are unsupported`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`[ui/start] Cannot serialize ${path}.${key}: expected a data property`);
      }
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
        throw new TypeError(
          `[ui/start] Cannot serialize ${path}: extra array properties are unsupported`,
        );
      }
      (result as Record<string, JsonValue>)[key] = cloneJson(
        descriptor.value,
        `${path}.${key}`,
        ancestors,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

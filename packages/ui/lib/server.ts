import type { ScopeSnapshot } from "@virentia/core";
import {
  childContext,
  componentView,
  createRootContext,
  foreign,
  foreignHostTag,
  forItems,
  forKey,
  Fragment,
  htmlNamespace,
  isElement,
  list,
  listKeyPaths,
  mathNamespace,
  portal,
  provider,
  readSource,
  rawText,
  runIn,
  settleRetained,
  show,
  svgDashedAttributes,
  svgNamespace,
  booleanAttributes,
  voidElements,
  type ForProps,
  type ForeignProps,
  type RenderOptions,
  type ShowProps,
  type UIContext,
} from "./runtime";
import type { Child, ElementDescriptor } from "./types";

interface Output {
  html: string;
  text: string;
}

interface Selection {
  values: Set<string>;
  multiple: boolean;
  matched: boolean;
}

interface State {
  markers: boolean;
  selection?: Selection;
  pending?: Promise<string>[];
}

const empty: Output = { html: "", text: "" };
const validTag = /^[A-Za-z][A-Za-z0-9:_-]*$/;
// eslint-disable-next-line no-control-regex -- Control characters cannot appear in attribute names.
const validAttribute = /^[^\u0000-\u0020\u007f"'<>/=]+$/;

function escapeText(value: string): string {
  return value.replace(
    /[&<>\r]/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\r": "&#13;" })[character]!,
  );
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function combine(outputs: readonly Output[]): Output {
  return {
    html: outputs.map((output) => output.html).join(""),
    text: outputs.map((output) => output.text).join(""),
  };
}

function region(output: Output, state: State): Output {
  return state.markers ? { html: `<!--ui-->${output.html}<!--/ui-->`, text: output.text } : output;
}

function dynamic(read: () => Child, ctx: UIContext, state: State): Output {
  const target = childContext(ctx);
  const value = runIn(target, read);
  // Client regions skip their first content lifetime when the initial read is undefined.
  if (value === undefined) return region(empty, state);
  const content = childContext(target);
  return region(
    runIn(content, () => walk(value, content, state)),
    state,
  );
}

function walk(value: Child, ctx: UIContext, state: State): Output {
  if (value == null || typeof value === "boolean") return empty;
  if (typeof value === "function") return dynamic(value, ctx, state);
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    const text = String(value);
    return { html: `${state.markers ? "<!--ui:t-->" : ""}${escapeText(text)}`, text };
  }
  if (Array.isArray(value)) return combine(value.map((item) => walk(item, ctx, state)));
  if (isElement(value)) return description(value, ctx, state);
  if (typeof value === "object" && "then" in value) {
    throw new TypeError(
      "[ui/server] Async children are not supported; resolve data before rendering",
    );
  }
  if (typeof value === "object" && "nodeType" in value) {
    throw new TypeError("[ui/server] Native DOM nodes cannot be serialized; return JSX instead");
  }
  throw new TypeError("[ui/server] Unsupported child; render a primitive, JSX element or accessor");
}

function description(value: ElementDescriptor, ctx: UIContext, state: State): Output {
  const { type, props } = value;
  if (type === Fragment) return dynamic(() => props.children as Child, ctx, state);
  if (type === foreign) {
    const host = childContext(ctx);
    const tag = foreignHostTag(props.as, host.namespace);
    const config = props as unknown as ForeignProps<unknown>;
    const serverRender = config.serverRender;
    if (!serverRender) return { html: `<${tag}></${tag}>`, text: "" };
    if (config.asyncServerRender && !state.pending) {
      throw new TypeError("[ui/server] This foreign tree requires renderToStringAsync()");
    }
    let rendered!: string | Promise<string>;
    // Core's scoped() holds its ambient scope when the callback returns a
    // promise. Keep this frame synchronous so concurrent SSR requests cannot
    // inherit each other's scope while a foreign renderer is awaiting data.
    runIn(host, () => {
      rendered = serverRender(config.node, host.scope);
    });
    let content: string;
    if (state.pending) {
      // Defer synchronous foreign HTML too, so a comment inside it can never be
      // mistaken for one of our placeholders when asynchronous siblings settle.
      content = `<!--ui:ssr:${state.pending.length}-->`;
      state.pending.push(Promise.resolve(rendered).then(validateForeignHtml));
    } else if (typeof rendered === "string") content = rendered;
    else if (rendered && typeof rendered.then === "function") {
      void Promise.resolve(rendered).catch(() => {});
      throw new TypeError("[ui/server] This foreign tree requires renderToStringAsync()");
    } else content = validateForeignHtml(rendered);
    const marker = state.markers
      ? ` data-ui-ssr="${escapeAttribute(config.kind ?? "foreign")}"`
      : "";
    return { html: `<${tag}${marker}>${content}</${tag}>`, text: "" };
  }
  if (type === portal) {
    throw new Error(
      "[ui/server] Portal has no server transport; mount portal content after the client mounted event",
    );
  }
  if (type === provider) {
    const child = childContext(ctx);
    const values = new Map(ctx.values);
    values.set(props.id as symbol, () => props.value);
    child.values = values;
    return runIn(child, () => dynamic(() => props.children as Child, child, state));
  }
  if (type === show) {
    const target = childContext(ctx);
    const config = props as unknown as ShowProps;
    const visible = runIn(target, () => Boolean(readSource(config.when)));
    const content = childContext(target, visible ? "shown" : "fallback");
    return region(
      runIn(content, () =>
        dynamic(() => (visible ? config.children : config.fallback), content, state),
      ),
      state,
    );
  }
  if (type === list) {
    const target = childContext(ctx);
    const rowPath = listKeyPaths();
    const config = props as unknown as ForProps<unknown>;
    const { items, keys } = runIn(target, () => {
      const items = forItems(config.each, target.scope);
      const keys = items.map((item) => forKey(item, config.by));
      if (new Set(keys).size !== keys.length) throw new Error("[ui] For requires unique keys");
      return { items, keys };
    });
    if (!items.length) {
      const fallback = childContext(target);
      return region(
        runIn(fallback, () => dynamic(() => config.fallback, fallback, state)),
        state,
      );
    }
    return region(
      combine(
        items.map((item, index) => {
          const row = childContext(target, rowPath(keys[index]));
          return region(
            runIn(row, () =>
              walk(
                config.children(
                  () => item,
                  () => index,
                ),
                row,
                state,
              ),
            ),
            state,
          );
        }),
      ),
      state,
    );
  }
  if (typeof type === "function") {
    const child = childContext(ctx);
    return runIn(child, () => walk(componentView(type, props, child), child, state));
  }
  if (typeof type === "string") return element(type, props, ctx, state);
  throw new TypeError("[ui/server] Unsupported element type");
}

function styleText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value !== "object" || Array.isArray(value))
    throw new TypeError("[ui/server] style must be a string or property object");
  return Object.entries(value)
    .filter(([, item]) => item != null)
    .map(([key, item]) => {
      const name = key.startsWith("--")
        ? key
        : key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      if (!/^--[^\s:;]+$|^[a-zA-Z-][a-zA-Z0-9-]*$/.test(name))
        throw new Error(`[ui/server] Invalid style property: ${key}`);
      return `${name}:${String(item)}`;
    })
    .join(";");
}

function attributes(
  values: Map<string, unknown>,
  namespace: string,
  tag: string,
): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const [key, value] of values) {
    if (
      key === "children" ||
      key === "key" ||
      key === "ref" ||
      key === "classList" ||
      /^on/i.test(key)
    )
      continue;
    if (key === "innerHTML" || key === "dangerouslySetInnerHTML" || key === "textContent") {
      throw new Error(`[ui] ${key} cannot be mixed with owned DOM children`);
    }
    if (key === "indeterminate") continue;
    if ((tag === "select" || tag === "textarea") && (key === "value" || key === "defaultValue"))
      continue;
    if (key === "defaultValue" && values.has("value")) continue;
    if (key === "defaultChecked" && values.has("checked")) continue;
    let name =
      key === "className"
        ? "class"
        : key === "htmlFor"
          ? "for"
          : key === "defaultValue"
            ? "value"
            : key === "defaultChecked"
              ? "checked"
              : key;
    if (namespace === htmlNamespace) name = name.toLowerCase();
    else if (svgDashedAttributes.has(name))
      name = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    if (!validAttribute.test(name)) throw new Error(`[ui/server] Invalid attribute name: ${key}`);
    result.set(name, key === "style" ? styleText(value) : value);
  }
  const classList = values.get("classList");
  if (classList != null) {
    if (typeof classList !== "object" || Array.isArray(classList))
      throw new TypeError("[ui/server] classList must be a token map");
    const classes = new Set(
      String(result.get("class") ?? "")
        .split(/\s+/)
        .filter(Boolean),
    );
    for (const [token, enabled] of Object.entries(classList)) {
      if (!token || /\s/.test(token))
        throw new Error("[ui/server] classList keys must be individual nonempty tokens");
      if (enabled) classes.add(token);
      else classes.delete(token);
    }
    if (classes.size || result.has("class")) result.set("class", [...classes].join(" "));
  }
  return result;
}

function printAttributes(values: Map<string, unknown>): string {
  let output = "";
  for (const [name, value] of values) {
    if (value == null) continue;
    if (booleanAttributes.has(name.toLowerCase())) {
      if (value) output += ` ${name}`;
    } else output += ` ${name}="${escapeAttribute(String(value))}"`;
  }
  return output;
}

function element(
  tag: string,
  props: Record<string, unknown>,
  ctx: UIContext,
  state: State,
): Output {
  if (!validTag.test(tag)) throw new Error(`[ui/server] Invalid tag name: ${tag}`);
  const namespace = tag === "svg" ? svgNamespace : tag === "math" ? mathNamespace : ctx.namespace;
  const child = childContext(ctx);
  child.namespace = tag === "foreignObject" ? htmlNamespace : namespace;
  return runIn(child, () => {
    const values = new Map<string, unknown>();
    for (const key of Object.keys(props)) {
      if (key !== "children" && key !== "key") values.set(key, props[key]);
    }
    const html = namespace === htmlNamespace;
    const name = html ? tag.toLowerCase() : tag;
    const attrs = attributes(values, namespace, name);
    if (html && voidElements.has(name)) {
      const children = props.children;
      if (children != null && typeof children !== "boolean") {
        throw new Error(`[ui/server] Void element <${name}> cannot have children`);
      }
      return { html: `<${name}${printAttributes(attrs)}>`, text: "" };
    }
    let content: Output;
    if (html && (name === "script" || name === "style")) {
      if (rawText(props.children) !== "") {
        throw new Error(
          `[ui/server] Inline <${name}> children are unsupported; load external assets or use the client mounted event`,
        );
      }
      content = empty;
    } else if (html && (name === "textarea" || name === "title")) {
      const text = rawText(
        name === "textarea" && (values.has("value") || values.has("defaultValue"))
          ? values.has("value")
            ? values.get("value")
            : values.get("defaultValue")
          : props.children,
      );
      const escaped = escapeText(text);
      content = {
        html: name === "textarea" && text.startsWith("\n") ? `\n${escaped}` : escaped,
        text,
      };
    } else {
      let childState = state;
      if (html && name === "select") {
        const value = values.has("value") ? values.get("value") : values.get("defaultValue");
        childState = {
          ...state,
          selection:
            values.has("value") || values.has("defaultValue")
              ? {
                  values: new Set((Array.isArray(value) ? value : [value ?? ""]).map(String)),
                  multiple: Boolean(values.get("multiple")),
                  matched: false,
                }
              : undefined,
        };
      }
      content = dynamic(() => props.children as Child, child, childState);
    }
    if (html && name === "pre" && !state.markers && content.html.startsWith("\n")) {
      content = { ...content, html: `\n${content.html}` };
    }
    if (html && name === "option" && state.selection) {
      const selection = state.selection;
      const optionValue = values.has("value")
        ? String(values.get("value") ?? "")
        : content.text.replace(/[\t\n\f\r ]+/g, " ").trim();
      const selected =
        selection.values.has(optionValue) && (selection.multiple || !selection.matched);
      attrs.set("selected", selected);
      if (selected) selection.matched = true;
    }
    return {
      html: `<${name}${printAttributes(attrs)}>${content.html}</${name}>`,
      text: content.text,
    };
  });
}

function validateForeignHtml(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("[ui/server] A foreign renderer must return an HTML string");
  }
  return value;
}

function finishRender(ctx: UIContext, result: string, failed: boolean, failure?: unknown): string {
  ctx.root.serverSucceeded = !failed;
  try {
    runIn(ctx, () => ctx.owner.dispose());
  } catch (cleanupError) {
    settleRetained(ctx.root, false);
    if (failed)
      throw new AggregateError([failure, cleanupError], "[ui/server] Rendering and cleanup failed");
    throw cleanupError;
  }
  settleRetained(ctx.root, !failed);
  if (failed) throw failure;
  return result;
}

function render(factory: () => Child, options: RenderOptions, markers: boolean): string {
  const ctx = createRootContext({ ...options, server: true });
  let result = "";
  let failed = false;
  let failure: unknown;
  try {
    result = runIn(ctx, () => walk(factory(), ctx, { markers }).html);
  } catch (error) {
    failed = true;
    failure = error;
  }
  return finishRender(ctx, result, failed, failure);
}

async function renderAsync(
  factory: () => Child,
  options: RenderOptions,
  markers: boolean,
): Promise<string> {
  const ctx = createRootContext({ ...options, server: true });
  const pending: Promise<string>[] = [];
  const failures: unknown[] = [];
  let result = "";
  try {
    result = runIn(ctx, () => walk(factory(), ctx, { markers, pending }).html);
  } catch (error) {
    failures.push(error);
  }
  // Even after a sibling fails, every started renderer must settle before its
  // native component owner and request state can be released.
  const outputs = await Promise.allSettled(pending);
  for (const output of outputs) {
    if (output.status === "rejected") failures.push(output.reason);
  }
  if (!failures.length) {
    // Replace only markers in the native output. Foreign HTML is inserted in one
    // pass and never scanned again, even if it contains similar comment text.
    result = result.replace(/<!--ui:ssr:(\d+)-->/g, (_marker, index: string) => {
      const output = outputs[Number(index)] as PromiseFulfilledResult<string>;
      return output.value;
    });
  }
  return finishRender(
    ctx,
    result,
    failures.length > 0,
    failures.length > 1
      ? new AggregateError(failures, "[ui/server] Multiple renderers failed")
      : failures[0],
  );
}

/** Render synchronous HTML with boundaries that hydrate() can adopt in place. */
export function renderToString(factory: () => Child, options: RenderOptions = {}): string {
  return render(factory, options, true);
}

/** Await foreign SSR renderers, then return HTML that hydrate() can adopt in place. */
export function renderToStringAsync(
  factory: () => Child,
  options: RenderOptions = {},
): Promise<string> {
  return renderAsync(factory, options, true);
}

/** Render synchronous HTML without hydration metadata. */
export function renderToStaticMarkup(factory: () => Child, options: RenderOptions = {}): string {
  return render(factory, options, false);
}

/** Await foreign SSR renderers and omit native hydration metadata. */
export function renderToStaticMarkupAsync(
  factory: () => Child,
  options: RenderOptions = {},
): Promise<string> {
  return renderAsync(factory, options, false);
}

/** Safely embed an explicit, JSON-compatible core snapshot in an HTML script. */
export function serializeState(snapshot: ScopeSnapshot): string {
  return JSON.stringify(snapshot).replace(
    /[<>&\u2028\u2029]/g,
    (character) =>
      ({
        "<": "\\u003c",
        ">": "\\u003e",
        "&": "\\u0026",
        "\u2028": "\\u2028",
        "\u2029": "\\u2029",
      })[character]!,
  );
}

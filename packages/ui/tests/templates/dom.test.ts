import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scope, scoped } from "@virentia/core";
import * as core from "@virentia/core";
import * as coreInternal from "@virentia/core/internal";
import * as models from "@virentia/core/models";
import * as modelsInternal from "../../../core/lib/models/definition";
import * as mutable from "@virentia/mutable";
import { parseSync, transformWithOxc } from "vite";
import { describe, expect, it } from "vitest";
import { SourceEdits } from "@virentia/core/compiler/vite";
import { addTemplateEdits } from "../../compiler/templates";
import * as ui from "../../lib";
import * as jsxRuntime from "../../lib/jsx-runtime";
import { lifetime } from "../../lib/lifetime";
import * as runtime from "../../lib/runtime";
import { renderToString } from "../../lib/server";
import type { Scenario } from "./fixtures/app";

// The fixture app mounted from the JSX runtime's output and from compiled
// templates: the same DOM, the same component paths and the same behavior
// after every step, on the client, on the server and when hydrating.

const fixture = join(__dirname, "fixtures/app.tsx");

async function load(templates: boolean): Promise<Record<string, () => Scenario>> {
  return (await evaluate(readFileSync(fixture, "utf8"), templates ? 20 : undefined)) as never;
}

/** A module's default export, compiled with at least `templates` templates when given. */
async function evaluate(source: string, templates?: number): Promise<unknown> {
  let code = source;
  if (templates !== undefined) {
    const { program, errors } = parseSync("app.tsx", source, { lang: "tsx", sourceType: "module" });
    expect(errors).toEqual([]);
    const edits = new SourceEdits(source);
    expect(addTemplateEdits(program as never, source, edits)).toBeGreaterThanOrEqual(templates);
    code = edits.apply("app.tsx").code;
  }
  const result = await transformWithOxc(code, "app.tsx", {
    lang: "tsx",
    jsx: { runtime: "automatic", importSource: "@virentia/ui" },
  });
  const modules: Record<string, unknown> = {
    "@virentia/core": core,
    "@virentia/core/internal": coreInternal,
    "@virentia/core/models": models,
    "@virentia/mutable": mutable,
    "@virentia/ui": ui,
    "@virentia/ui/jsx-runtime": jsxRuntime,
    "../../../lib/runtime": runtime,
  };
  const body = result.code
    .replace(
      /import\s*\{([^}]*)\}\s*from\s*"([^"]+)";?/g,
      (_match, names: string, from: string) => {
        if (!(from in modules)) throw new Error(`fixture imports ${from}`);
        return `const {${names.replace(/\bas\b/g, ":")}} = __modules[${JSON.stringify(from)}];`;
      },
    )
    .replace(/export\s+default\s+/, "return ");
  return new Function("__modules", body)(modules);
}

const htmlNamespace = "http://www.w3.org/1999/xhtml";
function dump(node: Node): string {
  if (node.nodeType === 3) return JSON.stringify(node.textContent);
  if (node.nodeType === 8) return `<!--${(node as Comment).data}-->`;
  if (node.nodeType !== 1) return `#${node.nodeType}`;
  const element = node as Element;
  const namespace = element.namespaceURI === htmlNamespace ? "" : `{${element.namespaceURI}}`;
  const attributes = [...element.attributes]
    .map(
      (attribute) =>
        ` ${attribute.namespaceURI ? `{${attribute.namespaceURI}}` : ""}${attribute.name}=${JSON.stringify(attribute.value)}`,
    )
    .join("");
  const live = element as unknown as Record<string, unknown>;
  const properties =
    element.localName === "input"
      ? ` .value=${JSON.stringify(live.value)} .checked=${live.checked}`
      : element.localName === "option"
        ? ` .selected=${live.selected}`
        : element.localName === "select"
          ? ` .value=${JSON.stringify(live.value)}`
          : "";
  return `<${namespace}${element.localName}${attributes}${properties}>${[...element.childNodes].map(dump).join("")}</>`;
}

interface Run {
  records: unknown[];
  errors: unknown[];
}

async function mountScenario(
  create: () => Scenario,
  mode: "render" | "hydrate",
  html?: string,
): Promise<Run> {
  const app = scope();
  const page = document.implementation.createHTMLDocument("templates");
  const container = page.createElement("div");
  page.body.append(container);
  const owner = lifetime();
  const scenario = scoped(app, create);
  const records: unknown[] = [];
  const errors: unknown[] = [];
  const record = () =>
    records.push({ dom: dump(container), probe: scoped(app, () => scenario.probe?.(container)) });
  try {
    if (html !== undefined) container.innerHTML = html;
    const options = { scope: app, owner, identifierPrefix: "test" };
    const detach =
      mode === "render"
        ? runtime.render(scenario.view, container, options)
        : runtime.hydrate(scenario.view, container, options);
    record();
    for (const step of scenario.steps ?? []) {
      await scoped(app, () => step(container));
      record();
    }
    await scoped(app, () => detach());
    record();
  } catch (error) {
    errors.push(error);
  } finally {
    // Refs outside models are scope-bound stores: their cleanup reads them.
    await scoped(app, () => owner.dispose());
  }
  return { records, errors };
}

const plain = await load(false);
const compiled = await load(true);

describe("compiled templates mount like the JSX runtime's descriptions", () => {
  for (const name of Object.keys(plain)) {
    it(`on the client: ${name}`, async () => {
      const expected = await mountScenario(plain[name], "render");
      expect(expected.errors).toEqual([]);
      const actual = await mountScenario(compiled[name], "render");
      expect(actual).toEqual(expected);
    });
  }

  for (const name of Object.keys(plain)) {
    if (!scoped(scope(), plain[name]).server) continue;
    it(`on the server and when hydrating: ${name}`, async () => {
      const serverHTML = (variant: Record<string, () => Scenario>) => {
        const app = scope();
        const scenario = scoped(app, variant[name]);
        return renderToString(scenario.view, { scope: app, identifierPrefix: "test" });
      };
      const html = serverHTML(plain);
      expect(serverHTML(compiled)).toBe(html);
      const expected = await mountScenario(plain[name], "hydrate", html);
      expect(expected.errors).toEqual([]);
      expect(await mountScenario(compiled[name], "hydrate", html)).toEqual(expected);
    });
  }
});

describe("template prototypes", () => {
  it("are built away from the page, so nothing in them loads; clones belong to the page", async () => {
    const view = (await evaluate(
      `export default () => <p class="card"><img src="a.png" alt="A" /><svg><image href="b.png" /></svg></p>;`,
      1,
    )) as () => unknown;
    const page = document.implementation.createHTMLDocument("prototypes");
    const container = page.createElement("div");
    page.body.append(container);
    const created: string[] = [];
    const { createElement, createElementNS } = page;
    page.createElement = function (this: Document, tag: string) {
      created.push(tag);
      return createElement.call(this, tag);
    } as never;
    page.createElementNS = function (this: Document, namespace: string, tag: string) {
      created.push(tag);
      return createElementNS.call(this, namespace, tag);
    } as never;
    const app = scope();
    const owner = lifetime();
    const options = { scope: app, owner, identifierPrefix: "test" };
    for (let round = 0; round < 2; round++) {
      const detach = runtime.render(view as never, container, options);
      expect(container.innerHTML).toBe(
        '<p class="card"><img src="a.png" alt="A"><svg><image href="b.png"></image></svg></p>',
      );
      expect(container.querySelector("img")!.ownerDocument).toBe(page);
      expect(container.querySelector("image")!.ownerDocument).toBe(page);
      await scoped(app, () => detach());
    }
    expect(created).toEqual([]);
    await scoped(app, () => owner.dispose());
  });
});

describe("model members of compiled views", () => {
  it("bind without the members' facades", async () => {
    const source = `
      import { computed, event, reaction } from "@virentia/core";
      import { f, staticModel } from "@virentia/core/models";
      import { component, For, ui } from "@virentia/ui";
      const Row = staticModel({
        name: "DirectRow",
        with: [ui],
        data: { label: f.string(""), count: f.number(0) },
        setup(self) {
          const shout = computed(() => self.label.value.toUpperCase());
          const bump = event();
          reaction({ on: bump, run: () => void self.count.value++ });
          return { shout, bump };
        },
      });
      const View = component({
        model: Row,
        view: (_props, self) => (
          <li class={self.model.shout}>
            {self.model.label} {self.model.count}
            <button onClick={self.model.bump}>+</button>
          </li>
        ),
      });
      export default { Row, view: () => <ul><For each={Row} view={View} /></ul> };
    `;
    const { Row, view } = (await evaluate(source, 2)) as {
      Row: { create(input: object): any };
      view: () => unknown;
    };
    const app = scope();
    const page = document.implementation.createHTMLDocument("members");
    const container = page.createElement("div");
    page.body.append(container);
    const owner = lifetime();
    const row = scoped(app, () => Row.create({ id: "a", label: "a" }));
    const internal = coreInternalOf(row);
    const detach = runtime.render(view as never, container, { scope: app, owner });
    expect(container.innerHTML).toBe(
      '<ul><!--ui--><li class="A">a 0<button>+</button></li><!--/ui--></ul>',
    );
    // Read and called in place: no member needed its facade.
    const facades = () =>
      ["label", "count", "shout", "bump"].filter((name) => hasFacade(internal, name));
    expect(facades()).toEqual([]);
    container.querySelector("button")!.click();
    await scoped(app, () => (row.label.value = "b"));
    expect(container.innerHTML).toBe(
      '<ul><!--ui--><li class="B">b 1<button>+</button></li><!--/ui--></ul>',
    );
    await scoped(app, () => detach());
    await scoped(app, () => owner.dispose());
  });
});

/** The instance state behind a model instance. */
function coreInternalOf(instance: object): { facadeHandles: unknown; firstFacadeHandle?: string } {
  return modelsInternal.instanceInternalOf(instance) as never;
}
/** Whether `model[name]` was created and cached (see the instance proxy's `get`). */
function hasFacade(internal: ReturnType<typeof coreInternalOf>, name: string): boolean {
  return internal.firstFacadeHandle === undefined
    ? (internal.facadeHandles as Record<string, unknown> | undefined)?.[name] !== undefined
    : internal.firstFacadeHandle === name;
}

describe("props of a compiled description", () => {
  it("reflect as an ordinary object, frozen or with a non-configurable property", async () => {
    const make = (await evaluate(
      `export default (title) => <p title={title} class="c">{title}</p>;`,
      1,
    )) as (title: string) => { props: Record<string, unknown> };
    const props = make("a").props;
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
    expect(Object.keys(props)).toEqual(["title", "class", "children"]);
    props.title = "b";
    Object.defineProperty(props, "fixed", { value: 1 });
    expect(Object.getOwnPropertyDescriptor(props, "fixed")).toEqual({
      value: 1,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    Object.freeze(props);
    expect(Object.isFrozen(props)).toBe(true);
    expect(Object.isExtensible(props)).toBe(false);
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
    expect({ ...props }).toEqual({ title: "b", class: "c", children: "a" });
    expect(() => {
      props.title = "c";
    }).toThrow(TypeError);
    expect(Reflect.ownKeys(props)).toEqual(["title", "class", "children", "fixed"]);

    const other = make("x").props;
    Object.setPrototypeOf(other, null);
    Object.preventExtensions(other);
    expect(Object.getPrototypeOf(other)).toBeNull();
    expect(other.title).toBe("x");
    expect("toString" in other).toBe(false);
  });

  it("mount through those props once they are used", async () => {
    const make = (await evaluate(
      `export default (title) => <p title={title} class="c">{title}</p>;`,
      1,
    )) as (title: string) => { props: Record<string, unknown> };
    const description = make("a");
    description.props.title = "b";
    Object.freeze(description.props);
    const page = document.implementation.createHTMLDocument("props");
    const container = page.createElement("div");
    page.body.append(container);
    const app = scope();
    const owner = lifetime();
    const detach = runtime.render(() => description as never, container, { scope: app, owner });
    expect(container.innerHTML).toBe('<p title="b" class="c">a</p>');
    await scoped(app, () => detach());
    await scoped(app, () => owner.dispose());
  });

  it("act on the receiver, as an ordinary object's do", async () => {
    const make = (await evaluate(
      `export default (title) => <p title={title} class="c">{title}</p>;`,
      1,
    )) as (title: string) => { props: Record<string, unknown> };
    const props = make("a").props;
    const derived = Object.create(props) as Record<string, unknown>;
    derived.title = "b";
    expect(Object.hasOwn(derived, "title")).toBe(true);
    expect(props.title).toBe("a");
    Object.defineProperty(props, "self", {
      get() {
        return this;
      },
      configurable: true,
    });
    expect(props.self).toBe(props);
    expect(derived.self).toBe(derived);
    // An existing property written through the props stays configurable.
    props.class = "d";
    expect(Object.getOwnPropertyDescriptor(props, "class")).toEqual({
      value: "d",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Object.isExtensible(props)).toBe(true);
  });

  it("show as those props in Node's inspector", async () => {
    const { inspect } = await import("node:util");
    const make = (await evaluate(
      `export default (title) => <p title={title} class="c">{title}</p>;`,
      1,
    )) as (title: string) => { props: Record<string, unknown> };
    expect(inspect(make("a").props)).toBe(inspect({ title: "a", class: "c", children: "a" }));
  });

  it("mount as replaced, on the client and on the server, like an ordinary description's", async () => {
    const make = (await evaluate(
      `export default (title) => <p title={title} class="c">{title}</p>;`,
      1,
    )) as (title: string) => { props: Record<string, unknown> };
    const descriptions = [
      () => make("a"),
      () => jsxRuntime.jsx("p", { title: "a", class: "c", children: "a" }, "k"),
      () => jsxRuntime.jsx("p", { title: "a", class: "c", children: "a" }),
    ];
    for (const create of descriptions) {
      const description = create() as { props: Record<string, unknown> };
      description.props = { title: "b", children: "y" };
      expect(
        renderToString(() => description as never, { scope: scope(), identifierPrefix: "test" }),
      ).toBe('<p title="b"><!--ui:t-->y</p>');
      const page = document.implementation.createHTMLDocument("props");
      const container = page.createElement("div");
      page.body.append(container);
      const app = scope();
      const owner = lifetime();
      const detach = runtime.render(() => description as never, container, { scope: app, owner });
      expect(container.innerHTML).toBe('<p title="b">y</p>');
      await scoped(app, () => detach());
      await scoped(app, () => owner.dispose());
    }
  });
});

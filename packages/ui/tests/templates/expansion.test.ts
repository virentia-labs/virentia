import { parseSync, transformWithOxc } from "vite";
import { describe, expect, it } from "vitest";
import { SourceEdits } from "@virentia/core/compiler/vite";
import { addTemplateEdits } from "../../compiler/templates";
import * as ui from "../../lib";
import * as jsxRuntime from "../../lib/jsx-runtime";
import { isElement } from "../../lib/runtime";

// A compiled template's description reads as the description tree the JSX
// runtime builds from oxc's output for the same JSX: the same types, props,
// prop order, children and values, evaluated in the same order.

async function build(source: string, templates: boolean): Promise<{ code: string; count: number }> {
  let code = source;
  let count = 0;
  if (templates) {
    const { program, errors } = parseSync("cases.tsx", source, {
      lang: "tsx",
      sourceType: "module",
    });
    expect(errors).toEqual([]);
    const edits = new SourceEdits(source);
    count = addTemplateEdits(program as never, source, edits);
    code = edits.apply("cases.tsx").code;
  }
  const result = await transformWithOxc(code, "cases.tsx", {
    lang: "tsx",
    jsx: { runtime: "automatic", importSource: "@virentia/ui" },
  });
  return { code: result.code, count };
}

/** Run an ES module of imports from the JSX runtime and one default export. */
function evaluate(code: string, globals: Record<string, unknown>): any {
  const body = code
    .replace(
      /import\s*\{([^}]*)\}\s*from\s*"([^"]+)";?/g,
      (_match, names: string, from: string) =>
        `const {${names.replace(/\bas\b/g, ":")}} = __load(${JSON.stringify(from)});`,
    )
    .replace(/export\s+default\s+/, "return ");
  // From source, like everything else here: `createElement` (a key after a
  // spread) comes from the package root.
  const load = (id: string) => {
    if (id === "@virentia/ui/jsx-runtime") return jsxRuntime;
    if (id === "@virentia/ui") return ui;
    throw new Error(`Unexpected import of ${id}`);
  };
  return new Function("__load", ...Object.keys(globals), body)(load, ...Object.values(globals));
}

/** A description tree as plain data: what user code can observe through `type` and `props`. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (isElement(value)) {
    const { type, props } = value as { type: unknown; props: Record<string, unknown> };
    const keys = Object.keys(props);
    return {
      type:
        typeof type === "function"
          ? `fn:${type.name}`
          : typeof type === "symbol"
            ? String(type)
            : type,
      keys,
      props: Object.fromEntries(keys.map((key) => [key, shape(props[key])])),
      own: Object.keys(value as object),
    };
  }
  return value;
}

function Comp() {
  return null;
}

function globals(log: string[]) {
  const L = (name: string, value: unknown = name) => {
    log.push(name);
    return value;
  };
  const handler = Object.assign(() => {}, { node: {} });
  const reference = { value: null, writable: true };
  // `self.model.<name>` is compiled as `jsxMember(self, name)`: for anything
  // but a view's self, that reads `self.model` and then the member, right there.
  const model = new Proxy({} as Record<string, unknown>, {
    get: (_target, key) =>
      typeof key === "string" ? L(`member ${key}`, `value ${key}`) : undefined,
  });
  const self = {
    get model() {
      return L("model", model);
    },
    get other() {
      return L("other", model);
    },
  };
  return { L, Comp, handler, reference, spread: { title: "spread" }, self, model };
}

async function compare(cases: string[]) {
  const source = `export default [\n${cases.map((jsx) => `  () => (${jsx}),`).join("\n")}\n];\n`;
  const plain = await build(source, false);
  const compiled = await build(source, true);
  const log: string[] = [];
  const shared = globals(log);
  const plainCases = evaluate(plain.code, shared);
  const compiledCases = evaluate(compiled.code, shared);
  for (let index = 0; index < cases.length; index++) {
    log.length = 0;
    const expected = shape(plainCases[index]());
    const plainLog = log.splice(0);
    const actual = shape(compiledCases[index]());
    expect({ jsx: cases[index], value: actual, log }).toEqual({
      jsx: cases[index],
      value: expected,
      log: plainLog,
    });
  }
  return compiled;
}

describe("compiled templates read as the JSX runtime's descriptions", () => {
  it("for text, entities, literals and nesting", async () => {
    const compiled = await compare([
      `<div>Hello</div>`,
      `<div>  padded  </div>`,
      `<p>
        Multi
        line   text
      </p>`,
      `<p>a &amp; b &lt;3 &#169; &#x263A; &nbsp;x&NotAnEntity; &amp</p>`,
      `<p title="&#+66; &#x+43;">&#+65; &#x+41; &#-65; &#0065; &#99999999999; &#xD800;</p>`,
      `<p title="a &amp; b" data-x="multi
          line" aria-label='single "quoted"'>x</p>`,
      `<i n={1} f={1.5} e={1e21} t={true} b={false} z={null} s={"str"} q={\`tpl\`} flag />`,
      `<p>{"lit"}{0}{null}{true}{false}{\`t\`}</p>`,
      `<p>a{/* comment */}b{}c</p>`,
      `<ul><li>one</li><li>two <b>bold</b></li></ul>`,
      `<div><span /></div>`,
      `<div><span class="a" /><span>{L("x")}</span></div>`,
      `<svg viewBox="0 0 10 10"><path d="M0 0" strokeWidth={2} /><foreignObject><div>x</div></foreignObject></svg>`,
      `<a xlink:href="#target" xml:lang="en">link</a>`,
      `<p>
      </p>`,
      `<p>{" "}</p>`,
      `<b>a</b>`,
    ]);
    expect(compiled.count).toBeGreaterThan(10);
  });

  it("for holes, in evaluation order", async () => {
    await compare([
      `<div id={L("id")} title={L("title")}>{L("child")}<b class={L("b")}>{L("inner")}</b>{L("tail")}</div>`,
      `<div onClick={L("click", handler)} ref={L("ref", reference)} class="static">{L("x")}</div>`,
      `<div class={L("class")} className="b" classList={L("list", { on: true })} />`,
      `<div style={L("style", { color: "red" })} value={L("value")} />`,
      `<div>{(L("a"), L("b"))}{L("c"), L("d")}</div>`,
      `<div>{[L("one"), L("two")]}</div>`,
      `<div>{L("cond") && <b>{L("nested")}</b>}</div>`,
      `<div title={<b>{L("attr jsx")}</b>} other=<i>{L("bare")}</i> />`,
      `<div><Comp a={L("comp")}><span>{L("comp child")}</span></Comp>{L("after")}</div>`,
      `<div><>{L("fragment")}<b /></></div>`,
      `<div><select value={L("select")}><option value="a">{L("option")}</option></select></div>`,
      `<div><textarea value={L("text")} /><my-element a={L("custom")}>x</my-element></div>`,
      `<div><input value={L("input")}>{L("void child")}</input></div>`,
      `<div><p key={L("key")}>{L("keyed")}</p><p {...L("spread", spread)}>{L("spread child")}</p></div>`,
      `<div><p children={L("children prop")} /></div>`,
      `<div>{/* @__PURE__ */ L("pure")}</div>`,
    ]);
  });

  it("for model members, of a view's self or anything else", async () => {
    const compiled = await compare([
      `<p title={self.model.label}>{self.model.count}</p>`,
      `<p>a {self.model.one} b {L("x")} {self.model.two}<i class={self.model.three} /></p>`,
      `<p onClick={self.model.handler}>{self.model.then}{self.model.id}</p>`,
      `<p>{self.model["label"]}{self.model?.label}{self?.model.label}{(self.model).label}</p>`,
      `<p>{self.other.label}{self.model.label.value}{model.label}{self.model}</p>`,
      `<p>{self.model.label}<Comp a={self.model.prop}>{self.model.child}</Comp></p>`,
      `<p>{L("cond") && <b>{self.model.nested}</b>}</p>`,
    ]);
    // Only `<identifier>.model.<name>` holes of compiled elements.
    expect(compiled.code.match(/_vt\$member\(self, "\w+"\)/g)).toEqual(
      ["label", "count", "one", "two", "three", "handler", "then", "id", "label", "nested"].map(
        (name) => `_vt$member(self, "${name}")`,
      ),
    );
  });

  it("for generated trees", async () => {
    let seed = 20261028;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const texts = [
      "a",
      "b c",
      " ",
      "  ",
      "\n",
      "\n  ",
      "\r\n\t",
      "&amp;",
      "&nbsp;",
      "&#65;",
      "x &lt; y",
      "\u00a0",
      "\t",
      "é",
    ];
    const tags = [
      "div",
      "span",
      "p",
      "b",
      "i",
      "ul",
      "li",
      "svg",
      "g",
      "input",
      "br",
      "my-el",
      "Comp",
      "select",
    ];
    let holes = 0;
    const attribute = (): string =>
      pick([
        () => `title="${pick(["t", "a &amp; b", "multi\n   line", ""])}"`,
        () => `id={L("h${holes++}")}`,
        () => `class="c${holes}"`,
        () => `className={L("h${holes++}")}`,
        () => `data-n={${pick(["1", "null", "true", '"s"', "`t`"])}}`,
        () => "disabled",
        () => `onClick={L("h${holes++}", handler)}`,
        () => `style="color: red"`,
        () => `value="v"`,
        () => `key="k"`,
        () => `{...L("h${holes++}", spread)}`,
      ])();
    const element = (depth: number): string => {
      const tag = pick(tags);
      const attributes = new Set<string>();
      for (let count = Math.floor(random() * 3); count > 0; count--) attributes.add(attribute());
      const names = [...attributes];
      const unique = names.filter(
        (entry, index) =>
          names.findIndex((other) => other.split("=")[0] === entry.split("=")[0]) === index,
      );
      const open = `<${tag}${unique.length ? ` ${unique.join(" ")}` : ""}`;
      const count = depth > 3 ? 0 : Math.floor(random() * 4);
      if (!count && random() < 0.5) return `${open} />`;
      let content = "";
      for (let index = 0; index < count; index++)
        content += pick([
          () => pick(texts),
          () => `{L("h${holes++}")}`,
          () => `{${pick(['"lit"', "1", "null", "true", "/* c */"])}}`,
          () => element(depth + 1),
          () => element(depth + 1),
        ])();
      return `${open}>${content}</${tag}>`;
    };
    const cases: string[] = [];
    for (let index = 0; index < 400; index++) cases.push(element(0));
    await compare(cases);
  });
});

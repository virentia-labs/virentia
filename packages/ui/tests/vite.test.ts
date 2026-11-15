import { createRequire } from "node:module";
import compiler from "@virentia/core/compiler";
import { describe, expect, it } from "vitest";
import virentiaUI from "../vite";

const babel = createRequire(import.meta.url)("@babel/core");

function sids(code: string): string[] {
  return Array.from(code.matchAll(/sid: "([^"]+)"/g), (match) => match[1]).sort();
}

/** The SIDs the Babel plugin gives the same source. */
function babelSids(source: string, filename: string, root: string): string[] {
  const result = babel.transformSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [[compiler, { root }]],
  });
  return sids(result.code);
}

/** Decode a source map's mappings: generated [line, column] → original [line, column]. */
function decode(mappings: string): [number, number, number, number][] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: [number, number, number, number][] = [];
  let originalLine = 0;
  let originalColumn = 0;
  mappings.split(";").forEach((line, generatedLine) => {
    let generatedColumn = 0;
    for (const segment of line ? line.split(",") : []) {
      const values: number[] = [];
      let value = 0;
      let shift = 0;
      for (const char of segment) {
        const digit = alphabet.indexOf(char);
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          values.push(value & 1 ? -(value >> 1) : value >> 1);
          value = shift = 0;
        }
      }
      generatedColumn += values[0];
      originalLine += values[2];
      originalColumn += values[3];
      out.push([generatedLine, generatedColumn, originalLine, originalColumn]);
    }
  });
  return out;
}

describe("standard JSX and optional SID adapter", () => {
  it("leaves JSX, control flow and props untouched while assigning only unit SIDs", () => {
    const plugin = virentiaUI({ root: "/project", namespace: "app", templates: false });
    const result = plugin.transform(
      `import { store } from "@virentia/ui";
      export function Counter() {
        const count = store(0);
        return () => <button title={() => count.value}>{count}</button>;
      }`,
      "/project/Counter.tsx",
    )!;
    expect(result.code).toContain("sid:");
    expect(result.code).toContain("<button");
    expect(result.code).toContain("{count}");
    expect(result.code).not.toContain("withRoot");
    expect(result.code).not.toContain("createElement");
    expect(result.code).not.toContain('get "title"');
    expect(result.map?.sources).toContain("/project/Counter.tsx");
    expect(plugin.config().oxc.jsx.importSource).toBe("@virentia/ui");
  });

  it("is optional, and disables all source rewriting with sid: false and templates: false", () => {
    expect(virentiaUI({ sid: false }).transform("export const x = 1", "/project/x.js")).toBeNull();
    expect(
      virentiaUI({ templates: false }).transform(
        "const App = () => <p>Hello</p>",
        "/project/App.tsx",
      ),
    ).toBeNull();
  });

  it("supports build filters and ignores dependencies and query modules", () => {
    const plugin = virentiaUI({ exclude: /foreign/ });
    const source = 'import { store } from "@virentia/ui"; const count = store(0); <p />;';
    for (const id of [
      "/project/foreign.tsx",
      "/project/node_modules/ui.tsx",
      "/project/App.tsx?raw",
    ])
      expect(plugin.transform(source, id)).toBeNull();
  });
});

describe("compiled templates", () => {
  it("compile native JSX by default, leaving components and dynamic places as JSX", () => {
    const result = virentiaUI().transform(
      `"use client";
      const App = (props) => <main class="app"><h1>Title</h1><Panel>{props.body}</Panel></main>;
      function This() { return <this><p>x</p></this>; }`,
      "/project/App.tsx",
    )!;
    expect(result.code).toMatch(
      /^"use client";\nimport \{ jsxTemplate as (\S+), jsxFromTemplate as (\S+) \} from "@virentia\/ui\/jsx-runtime";\nvar _vt\$1, _vt\$2;\n/,
    );
    // Created where first used: no module-level initializer an import cycle could outrun.
    expect(result.code).toContain(
      '_vt$from(_vt$1 || (_vt$1 = _vt$template(["main",[["class",0,"app"]],[[1,["h1",0,["Title"]]],0]])), [<Panel>{props.body}</Panel>])',
    );
    // `<this>` is the value of `this`, a component.
    expect(result.code).toContain(
      '<this>{_vt$from(_vt$2 || (_vt$2 = _vt$template(["p",0,["x"]])))}</this>',
    );
  });

  it("leave modules that hand their JSX to another runtime", () => {
    const plugin = virentiaUI();
    for (const pragma of [
      "/** @jsxImportSource react */",
      "/** @jsx h */",
      "/** @jsxRuntime classic */",
    ])
      expect(plugin.transform(`${pragma}\nconst a = <p>x</p>;`, "/project/a.tsx")).toBeNull();
    expect(
      plugin.transform(
        `/** @jsxImportSource @virentia/ui */\nconst a = <p>x</p>;`,
        "/project/a.tsx",
      ),
    ).not.toBeNull();
    const configured = virentiaUI();
    configured.configResolved({
      root: "/project",
      oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
    } as never);
    expect(configured.transform("const a = <p>x</p>;", "/project/a.tsx")).toBeNull();
  });

  it("share one pass with SIDs, which name offsets of the original source", () => {
    const source = `import { store, event } from "@virentia/ui";
      export function Counter() {
        const count = store(0);
        const clicked = event();
        return <button title="t" onClick={clicked}>{count} <b>{store(1)}</b></button>;
      }`;
    const result = virentiaUI({ root: "/project" }).transform(source, "/project/Counter.tsx")!;
    expect(result.code).toContain("_vt$template(");
    expect(sids(result.code)).toHaveLength(3);
    expect(sids(result.code)).toEqual(babelSids(source, "/project/Counter.tsx", "/project"));
  });

  it("map what they keep back to where it was written", () => {
    const source = `const view = (model) =>
  <ul class="list">
    <li>{model.first}</li>
    <li title={model.title}>{model.second}</li>
  </ul>;
`;
    const result = virentiaUI().transform(source, "/project/List.tsx")!;
    const lines = result.code.split("\n");
    const mappings = decode(result.map!.mappings);
    const original = (needle: string) => {
      const line = lines.findIndex((text) => text.includes(needle));
      const column = lines[line].indexOf(needle);
      const segment = mappings
        .filter(
          ([generatedLine, generatedColumn]) => generatedLine === line && generatedColumn <= column,
        )
        .at(-1)!;
      const offset = column - segment[1];
      return [segment[2], segment[3] + offset];
    };
    const at = (needle: string) => {
      const sourceLines = source.split("\n");
      const line = sourceLines.findIndex((text) => text.includes(needle));
      return [line, sourceLines[line].indexOf(needle)];
    };
    for (const needle of ["model.first", "model.title", "model.second", "const view"])
      expect(original(needle)).toEqual(at(needle));
  });
});

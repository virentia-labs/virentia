import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { event, reactive, readonlyReactive, scope, scoped, store } from "../../lib/index";
import { withSidScope } from "../../lib/scope/snapshot";
import { readInspectorNodeMeta } from "../../lib/kernel/inspector";
import compiler, { type CompilerOptions } from "../../compiler/index";

const babel = createRequire(import.meta.url)("@babel/core");

function compile(
  source: string,
  filename = "/checkout/src/units.ts",
  options: CompilerOptions = { root: "/checkout" },
) {
  return babel.transformSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    ast: true,
    parserOpts: { allowReturnOutsideFunction: true, plugins: ["typescript"] },
    plugins: [[compiler, options]],
  });
}

function generatedSids(source: string, filename?: string, options?: CompilerOptions): string[] {
  const result = compile(source, filename, options);
  const sids: string[] = [];
  babel.traverse(result.ast, {
    CallExpression(path: any) {
      for (const arg of path.node.arguments) {
        if (arg.type !== "ObjectExpression") continue;
        const sid = arg.properties.find(
          (property: any) =>
            property.key?.name === "sid" && property.value?.type === "StringLiteral",
        );
        if (sid) sids.push(sid.value.value);
      }
    },
  });
  return sids;
}

function execute(source: string, args: Record<string, unknown>) {
  const { ast } = compile(source);
  ast.program.body = ast.program.body.filter((node: any) => node.type !== "ImportDeclaration");
  const code = babel.transformFromAstSync(ast, undefined, {
    configFile: false,
    babelrc: false,
  }).code;
  return new Function(...Object.keys(args), code)(...Object.values(args));
}

describe("@virentia/core/compiler", () => {
  it("gives stores and events the same source identity across build roots", () => {
    const source = `import { store, reactive, event } from "@virentia/core";
      store(0); reactive({ count: 0 }); event(); event("changed");`;
    const server = generatedSids(source, "/srv/build/src/units.ts", { root: "/srv/build" });
    const client = generatedSids(source, "/home/project/src/units.ts", {
      root: "/home/project",
    });
    const windows = generatedSids(source, "C:\\work\\project\\src\\units.ts", {
      root: "C:\\work\\project",
    });
    expect(server).toEqual(client);
    expect(server).toEqual(windows);
    expect(new Set(server).size).toBe(4);
    expect(server.every((sid) => sid.includes("src%2Funits.ts"))).toBe(true);
  });

  it("recognizes only imported units, including aliases and namespaces", () => {
    const source = `import { store as state, event as signal } from "@virentia/core";
      import * as ui from "@virentia/ui";
      import { event as external } from "other";
      state(0); signal(); ui.event("done"); ui["reactive"]({ value: 1 });
      external();
      function shadowed(signal, ui) { signal(); ui.event(); }
      const unrelated = { event() {} }; unrelated.event();`;
    expect(generatedSids(source)).toHaveLength(4);
  });

  it("gives readonlyReactive SIDs through direct, alias and namespace imports", () => {
    const source = `import { readonlyReactive as locked, readonlyReactive } from "@virentia/core";
      import * as core from "@virentia/core";
      return [locked({ value: 0 }), readonlyReactive({ value: 1 }),
        core.readonlyReactive({ value: 2 }), core["readonlyReactive"]({ value: 3 })];`;
    expect(generatedSids(source)).toHaveLength(4);
    const units = execute(source, {
      locked: readonlyReactive,
      readonlyReactive,
      core: { readonlyReactive },
    });
    expect(units.map((unit: { sid?: string }) => unit.sid)).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);
    expect(new Set(units.map((unit: { sid?: string }) => unit.sid)).size).toBe(4);
  });

  it("preserves explicit event metadata and handles dynamic names or option objects", () => {
    const units = execute(
      `import { event } from "@virentia/core";
       const name = "renamed";
       const options = { name: "from options", sid: "manual" };
       return [event(name), event(options), event({ name: "literal", sid: "literal" })];`,
      { event },
    );
    expect(units.map((unit: ReturnType<typeof event>) => unit.sid)).toEqual([
      expect.stringContaining("src%2Funits.ts"),
      "manual",
      "literal",
    ]);
    expect(
      units.map((unit: ReturnType<typeof event>) => readInspectorNodeMeta(unit.node).name),
    ).toEqual(["renamed", "from options", "literal"]);
  });

  it("preserves store skip-token behavior after metadata insertion", () => {
    const units = execute(
      `import { store, reactive } from "@virentia/core";
       return [store(1), store(1, undefined), reactive({ value: 1 }, undefined)];`,
      { store, reactive },
    );
    expect(units.map((unit: { sid?: string }) => unit.sid)).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);
    scoped(scope(), () => {
      units[0].value = undefined;
      units[1].value = undefined;
      expect(units[0].value).toBeUndefined();
      expect(units[1].value).toBe(1);
    });
  });

  it("prefixes event SIDs with the active declaration namespace", () => {
    const signal = withSidScope("instance/2", () => event({ sid: "changed" }));
    expect(signal.sid).toBe("instance/2/changed");
    expect(readInspectorNodeMeta(signal.node).sid).toBe(signal.sid);
    expect(() => event({ sid: "" })).toThrow("Event SID must be a non-empty string");
  });

  it("supports opt-out and rejects unsafe call shapes", () => {
    const source = `import { event } from "@virentia/core"; event();`;
    expect(generatedSids(source, undefined, { sid: false })).toEqual([]);
    expect(() => compile(`import { event } from "@virentia/core"; event(...args);`)).toThrow(
      "no argument spreads",
    );
    expect(() => compile(`import { event } from "@virentia/core"; event(name, options);`)).toThrow(
      "object literal for the second argument",
    );
    expect(() =>
      compile(`import { store } from "@virentia/core"; store(0, undefined, opts);`),
    ).toThrow("object literal for the third argument");
  });
});

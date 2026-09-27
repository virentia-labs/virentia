import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { scope, scoped, store, reactive, serialize } from "@virentia/core";
import { withSidScope } from "@virentia/core/internal";
import compiler, { type CompilerOptions } from "../compiler/index";

const babel = createRequire(import.meta.url)("@babel/core");

function compile(
  source: string,
  filename: string | undefined = "/checkout/src/model.ts",
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

function generated(source: string, filename?: string, options?: CompilerOptions) {
  const result = compile(source, filename, options);
  const calls: { sid: string; hasSkipToken: boolean; arity: number }[] = [];
  babel.traverse(result.ast, {
    CallExpression(path: any) {
      const args = path.node.arguments;
      if (args[2]?.type !== "ObjectExpression") return;
      const properties = args[2].properties;
      const sid = properties.find(
        (property: any) => property.key?.name === "sid" && property.value?.type === "StringLiteral",
      );
      if (sid) {
        calls.push({
          sid: sid.value.value,
          hasSkipToken: properties.some(
            (property: any) =>
              property.key?.name === "hasSkipToken" && property.value?.value === true,
          ),
          arity: args.length,
        });
      }
    },
  });
  return { ...result, calls };
}

describe("stable store SID compilation", () => {
  it("uses root-relative canonical identity across POSIX and Windows build roots", () => {
    const source = `import { store } from "@virentia/core"; export const count = store(0);`;
    const server = generated(source, "/srv/build/src/model.ts", { root: "/srv/build" }).calls[0]
      .sid;
    const client = generated(source, "/home/user/project/src/model.ts", {
      root: "/home/user/project",
    }).calls[0].sid;
    const windows = generated(source, "C:\\work\\project\\src\\model.ts", {
      root: "C:\\work\\project",
    }).calls[0].sid;
    const network = generated(source, "\\\\server\\share\\project\\src\\model.ts", {
      root: "\\\\server\\share\\project",
    }).calls[0].sid;
    expect(server).toBe(client);
    expect(windows).toBe(server);
    expect(network).toBe(server);
    expect(server).toContain("src%2Fmodel.ts");
    expect(server).not.toContain("srv");
    expect(server).not.toContain("project");
  });

  it("distinguishes anonymous calls, modules and namespaces without hashing collisions", () => {
    const source = `import { store } from "@virentia/ui"; consume(store(0), store(0));`;
    const first = generated(source).calls;
    expect(first).toHaveLength(2);
    expect(first[0].sid).not.toBe(first[1].sid);
    expect(generated(source, "/checkout/src/other.ts").calls[0].sid).not.toBe(first[0].sid);
    expect(
      generated(source, "/checkout/src/model.ts", { root: "/checkout", namespace: "other-app" })
        .calls[0].sid,
    ).not.toBe(first[0].sid);
    expect(
      generated(source, "/checkout/src/model.ts", { root: "/checkout", namespace: "a:b" }).calls[0]
        .sid,
    ).not.toBe(
      generated(source, "/checkout/src/model.ts", { root: "/checkout", namespace: "a%3Ab" })
        .calls[0].sid,
    );
  });

  it("resolves aliased and namespace imports while leaving unrelated and shadowed calls alone", () => {
    const { calls, code } = generated(`
      import { store as state, reactive } from "@virentia/core";
      import * as ui from "@virentia/ui";
      import { store as external } from "other-package";
      state(0); reactive({ count: 0 }); ui.store(1); ui["reactive"]({ count: 1 });
      external(2);
      function shadowed(state, ui, reactive) { state(3); ui.store(4); reactive({}); }
      const unrelated = { store(value) { return value; } }; unrelated.store(5);
    `);
    expect(calls).toHaveLength(4);
    expect(code).toContain("external(2)");
    expect(code).toContain("state(3)");
    expect(code).toContain("ui.store(4)");
    expect(code).toContain("unrelated.store(5)");
  });

  it("preserves explicit sid and existing devtools fields/spreads", () => {
    const { calls, code } = generated(`import { store } from "@virentia/core";
      store(0, undefined, { name: "count", key: true });
      store(1, undefined, { sid: "manual", name: "manual count" });
      store(2, undefined, { ...options, name: "spread" });
    `);
    expect(calls).toHaveLength(3);
    expect(calls[1].sid).toBe("manual");
    expect(code).toContain('name: "count"');
    expect(code).toContain("key: true");
    expect(code).toMatch(/sid: "v1:[^"]+",\s+\.\.\.options/);
    expect(code.match(/sid: "manual"/g)).toHaveLength(1);
  });

  it("preserves explicit skip-token presence, including undefined at runtime", () => {
    const { ast, calls } = generated(`import { store, reactive } from "@virentia/core";
      const sentinel = undefined;
      const a = store(1);
      const b = store(1, undefined);
      const c = store(1, sentinel);
      const d = store(1, undefined, { name: "d" });
      const e = reactive({ count: 1 }, undefined);
      return { a, b, c, d, e };
    `);
    expect(calls.map((call: any) => call.hasSkipToken)).toEqual([false, true, true, false, true]);
    expect(calls.every((call: any) => call.arity === 3)).toBe(true);
    ast.program.body = ast.program.body.filter((node: any) => node.type !== "ImportDeclaration");
    const executable = babel.transformFromAstSync(ast, undefined, {
      configFile: false,
      babelrc: false,
    }).code;
    const units = new Function("store", "reactive", executable)(store, reactive);
    scoped(scope(), () => {
      for (const unit of [units.a, units.b, units.c, units.d]) unit.value = undefined;
      expect(units.a.value).toBeUndefined();
      expect(units.b.value).toBe(1);
      expect(units.c.value).toBe(1);
      expect(units.d.value).toBeUndefined();
    });
  });

  it("round-trips repeated factory instances across independent server/client builds", () => {
    const source = `import { store } from "@virentia/core"; return () => store(0);`;
    function build(root: string) {
      const { ast } = compile(source, `${root}/src/component.ts`, { root });
      ast.program.body = ast.program.body.filter((node: any) => node.type !== "ImportDeclaration");
      const executable = babel.transformFromAstSync(ast, undefined, {
        configFile: false,
        babelrc: false,
      }).code;
      return new Function("store", executable)(store) as () => ReturnType<typeof store<number>>;
    }
    const serverFactory = build("/srv/build");
    const clientFactory = build("/client/checkout");
    const serverA = withSidScope("app/0", serverFactory);
    const serverB = withSidScope("app/1", serverFactory);
    const server = scope();
    scoped(server, () => {
      serverA.value = 10;
      serverB.value = 20;
    });
    const snapshot = JSON.parse(JSON.stringify(serialize(server)));
    expect(Object.keys(snapshot)).toHaveLength(2);
    expect(serverA.sid).not.toBe(serverB.sid);

    const clientA = withSidScope("app/0", clientFactory);
    const clientB = withSidScope("app/1", clientFactory);
    const client = scope({ snapshot });
    expect(clientA.sid).toBe(serverA.sid);
    expect(clientB.sid).toBe(serverB.sid);
    expect(scoped(client, () => [clientA.value, clientB.value])).toEqual([10, 20]);
  });

  it("allows opting out and leaves filename-less Babel transforms alone", () => {
    const source = `import { store } from "@virentia/core"; const count = store(0);`;
    expect(generated(source, "/checkout/src/model.ts", { sid: false }).calls).toHaveLength(0);
    expect(compile(source, undefined, { sid: false }).code).not.toContain("sid:");
    const anonymous = babel.transformSync(source, {
      configFile: false,
      babelrc: false,
      plugins: [compiler],
    });
    expect(anonymous.code).not.toContain("sid:");
  });

  it("diagnoses arguments it cannot safely rewrite", () => {
    expect(() => compile(`import { store } from "@virentia/core"; store(...args);`)).toThrow(
      "no argument spreads",
    );
    expect(() =>
      compile(`import { store } from "@virentia/core"; store(0, undefined, options);`),
    ).toThrow("object literal for the third argument");
    expect(() =>
      compile(`import { store } from "@virentia/core"; store(...args);`, undefined, { sid: false }),
    ).not.toThrow();
  });
});

import { createRequire } from "node:module";
import compiler from "@virentia/core/compiler";
import virentiaCore, {
  addSidEdits,
  SourceEdits,
  sourceIdentity,
} from "@virentia/core/compiler/vite";
import { parseAst, parseSync } from "vite";
import { describe, expect, it } from "vitest";

// The oxc pass gives exactly the calls the Babel plugin gives a SID the same
// SID, and inserts it where the Babel plugin does.

const babel = createRequire(import.meta.url)("@babel/core");
const filename = "/checkout/src/units.tsx";
const root = "/checkout";

function viaBabel(source: string): string {
  return babel.transformSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    parserOpts: { sourceType: "unambiguous", plugins: ["typescript", "jsx"] },
    plugins: [[compiler, { root }]],
  }).code;
}

function viaOxc(source: string): string {
  const { program, errors } = parseSync(filename, source, {
    lang: "tsx",
    sourceType: "unambiguous",
  });
  if (errors.length) throw new Error(`parse: ${errors[0].message}`);
  const edits = new SourceEdits(source);
  addSidEdits(program as never, sourceIdentity(filename, root, root, undefined), edits);
  return edits.apply(filename).code;
}

const sids = (code: string) =>
  Array.from(code.matchAll(/sid: "([^"]+)"/g), (match) => match[1]).sort();

function sameSids(source: string) {
  let expected: string[];
  try {
    expected = sids(viaBabel(source));
  } catch {
    // Babel rejects the program (a redeclared import, say): nothing to compare.
    return false;
  }
  expect({ source, sids: sids(viaOxc(source)) }).toEqual({ source, sids: expected });
  return true;
}

const imports = `import { store, event, staticModel, model, reactive } from "@virentia/core";
import { mutableStore } from "@virentia/mutable";
import * as ui from "@virentia/ui";
import type { readonlyReactive } from "@virentia/core";
import { type event as typed } from "@virentia/core";
import other from "@virentia/core";
`;

describe("SIDs from oxc edits", () => {
  it("go to the calls Babel's scope analysis resolves to the imports", () => {
    const cases = [
      `store(0); event(); ui.store(1); ui["event"](); ui[\`store\`](2); staticModel({}); model({}); mutableStore([]);`,
      `typed(); readonlyReactive({}); other(); store?.(0); ui?.store(1); ui.store?.(2); (store)(3); (ui).event(); (0, store)(4);`,
      `store<number>(0); (store as any)(1); store!(2); new store(3); ui.other.store(4); ui[key](5);`,
      `function f(store, { event }, [ui] = [], ...rest) { store(0); event(); ui.store(1); reactive({}); }`,
      `const g = function store() { store(0); event(); }; const h = (event) => event() || store(1);`,
      `function f() { if (x) { var store = 1; } store(0); event(); } store(2);`,
      `{ let store = 1; store(0); } { const event = 2; event(); } { function ui() {} ui.store(); } { class reactive {} reactive({}); } store(9);`,
      `for (let store of []) store(0); for (const event in {}) { event(); } for (let ui = 0; ; ) ui.store(); store(1);`,
      `function f() { for (var store of []) {} store(0); }`,
      `try { store(0); } catch (store) { store(1); event(); } try {} catch ({ event }) { event(); }`,
      `switch (x) { case 0: let store = 1; store(0); default: event(); } store(1);`,
      `const C = class store { m() { store(0); } }; class D { m(event) { event(); } static { store(1); } p = store(2); [store(3)]() {} }`,
      `label: { store(0); } const o = { store() { store(1); }, get event() { return event(); }, [store(2)]: 1 };`,
      `namespace N { const store = 1; store(0); } namespace M { event(); } enum E { A = store(1) } store(2);`,
      `function f(a = store(0), store = 1) { store(2); } const g = (a = store(3)) => a;`,
      `const view = () => <div title={store(0)} onClick={() => event()}>{ui.store(1)}{[1].map((store) => store(2))}</div>;`,
      `export const a = store(0); export default event(); export function e(ui) { return ui.store(1); }`,
      `store(0, undefined, { sid: "manual" }); event({ sid: "manual" }); staticModel({ "sid": "manual" }); store(1, undefined, { ...o });`,
      `async function* g() { yield store(0); await event(); } const t = \`\${store(1)}\`; tag\`\${event()}\`;`,
      `if (a) store(0); else event(); while (b) store(1); do event(); while (c); x ? store(2) : event();`,
      // Parentheses are no nodes of Babel's tree.
      `ui[("store")](0); ui[(\`event\`)](); staticModel(({ name: "M" })); store(1, undefined, ({})); event(({})); event(n, ({ m: 1 })); mutableStore([], ({ [("sid")]: "manual" }));`,
      // A class's heritage sees the class's own name.
      `const k = class store extends store(0) {}; class L extends store(1) {} const m = class extends event() {};`,
      // Only a destructuring or defaulted parameter is a scope apart from the body.
      `class P { constructor(private a = store(0)) { let store = 1; } } function r(...[a = store(1)]) { let store = 1; } function s([a = store(2)], { b = event() }) { let store = 1; var event; }`,
    ];
    for (const body of cases) expect(sameSids(imports + body)).toBe(true);
  });

  it("go to the same calls in generated scopes", () => {
    let seed = 1028;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const names = ["store", "event", "ui", "staticModel", "mutableStore", "other"];
    const call = () =>
      pick([
        "store(0)",
        "store(1, undefined)",
        "event()",
        'event("n")',
        "ui.store(2)",
        'ui["event"]()',
        "staticModel({})",
        "mutableStore([])",
        "other()",
      ]);
    let unique = 0;
    const statement = (depth: number, inFunction: boolean): string => {
      const name = pick(names);
      const id = unique++;
      const body = (nested: boolean) => {
        let text = "";
        for (let count = 1 + Math.floor(random() * 3); count > 0; count--)
          text += statement(depth + 1, nested) + "\n";
        return text;
      };
      if (depth > 3) return `${call()};`;
      return pick([
        () => `${call()};`,
        () => `{ ${pick(["let", "const"])} ${name} = 1; ${body(inFunction)} }`,
        () => `{ function ${name}() { ${body(true)} } ${body(inFunction)} }`,
        () => `function f${id}(${name}, { a${id} } = {}) { ${body(true)} }`,
        () => `const g${id} = function ${name}() { ${body(true)} };`,
        () => `const h${id} = (${name} = ${call()}) => { ${body(true)} };`,
        () => `for (const ${name} of []) { ${body(inFunction)} }`,
        () => `try { ${body(inFunction)} } catch (${name}) { ${body(inFunction)} }`,
        () => `switch (0) { case 0: let ${name} = 1; ${body(inFunction)} }`,
        () => (inFunction ? `if (x) { var ${name} = 1; } ${call()};` : `${call()};`),
        () => `class K${id} { m(${name}) { ${body(true)} } static { ${body(true)} } }`,
        () => `const k${id} = class ${name} { m() { ${body(true)} } };`,
      ])();
    };
    let compared = 0;
    for (let index = 0; index < 400; index++) {
      let program = "";
      for (let count = 1 + Math.floor(random() * 4); count > 0; count--)
        program += statement(0, false) + "\n";
      if (sameSids(imports + program)) compared++;
    }
    expect(compared).toBeGreaterThan(300);
  });

  it("pass the arguments Babel passes", () => {
    const shapes = [
      "store(0)",
      "store(0,)",
      "store(0, undefined)",
      "store(0, skip)",
      'store(0, undefined, { name: "n" })',
      "store(0, undefined, {})",
      'store(0, undefined, { sid: "manual" })',
      'store(0, undefined, { ...options, name: "s" })',
      "store()",
      "event()",
      'event("n")',
      'event({ name: "n" })',
      "event({})",
      "event(name)",
      "event(name, { m: 1 })",
      "event(name, {})",
      "event( /* nothing */ )",
      'staticModel({ name: "M" })',
      "staticModel({})",
      "mutableStore()",
      "mutableStore([])",
      "mutableStore([], {})",
      'mutableStore([], { name: "m" })',
      "ui.store(1)",
      'ui["event"]("n")',
      "store((0))",
      "store((0), (undefined))",
      "store(0, undefined, ({}))",
      'event(({ name: "n" }))',
      "event((name))",
      "event((name), ({ m: 1 }))",
      'staticModel(({ name: "M" }))',
      "mutableStore(([]), ({}))",
      'ui[("store")]((1))',
    ];
    const run = (code: string) => {
      const calls: unknown[] = [];
      const record =
        (kind: string) =>
        (...args: unknown[]) =>
          calls.push([
            kind,
            args.length,
            ...args.map((arg) => (arg === undefined ? "<undefined>" : arg)),
          ]);
      const units = {
        store: record("store"),
        event: record("event"),
        staticModel: record("staticModel"),
        mutableStore: record("mutableStore"),
        ui: { store: record("ui.store"), event: record("ui.event") },
        skip: undefined,
        name: "dynamic",
        options: { name: "options" },
      };
      const body = code.replace(/^import .*$/gm, "");
      new Function(...Object.keys(units), body)(...Object.values(units));
      return calls;
    };
    const header = `import { store, event, staticModel } from "@virentia/core";
import { mutableStore } from "@virentia/mutable";
import * as ui from "@virentia/ui";
`;
    for (const shape of shapes) {
      const source = `${header}${shape};`;
      expect({ shape, calls: run(viaOxc(source)) }).toEqual({
        shape,
        calls: run(viaBabel(source)),
      });
    }
  });

  it("refuse the calls Babel refuses, with the same message", () => {
    for (const shape of [
      "store(...args)",
      "store(0, undefined, options)",
      "store(1, 2, {}, 4)",
      "event(...args)",
      "event(name, options)",
      "event(1, {}, 3)",
      "staticModel(config)",
      "staticModel()",
      "mutableStore([], options)",
    ]) {
      const source = `import { store, event, staticModel } from "@virentia/core";
import { mutableStore } from "@virentia/mutable";
${shape};`;
      let message = "";
      try {
        viaBabel(source);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(() => viaOxc(source)).toThrow();
      try {
        viaOxc(source);
      } catch (error) {
        expect(message).toContain((error as Error).message);
      }
    }
  });

  it("come from Rolldown's parser in the core Vite plugin under Vite 8", () => {
    const source = `${imports}store(0); (store)(1); ui.event(); function f(store) { store(2); }
staticModel(({ name: "M" })); store((3)); event((name), ({}));`;
    const plugin = virentiaCore({ root });
    const context = {
      meta: { rolldownVersion: "1.0.0" },
      parse: (code: string, options: object) => parseAst(code, options as never),
    };
    const result = plugin.transform.call(context as never, source, filename)!;
    expect(result.code).not.toBe(viaBabel(source));
    expect(sids(result.code)).toEqual(sids(viaBabel(source)));
    expect(sids(result.code)).toHaveLength(6);
    // After a parenthesized argument, not inside its parentheses.
    expect(result.code).toMatch(/store\(\(3\), void 0, \{ sid: "[^"]+" \}\)/);
    expect(result.code).toMatch(/event\(\(name\), \(\{ sid: "[^"]+" \}\)\)/);
    expect(result.map?.sources).toEqual([filename]);
    // Without Rolldown's parser it falls back to Babel.
    expect(sids(plugin.transform(source, filename)!.code)).toEqual(sids(result.code));
  });
});

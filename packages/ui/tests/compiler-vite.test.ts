import { describe, expect, it } from "vitest";
import virentiaUI from "../compiler/vite";

describe("Vite JSX compiler adapter", () => {
  it("runs before TypeScript erasure and preserves source maps", () => {
    const plugin = virentiaUI();
    const source = `type Props = { count: number };
      export const Counter = (props: Props) => <button title={props.count}>{props.count}</button>;`;
    const result = plugin.transform(source, "/project/src/Counter.tsx")!;

    expect(plugin.enforce).toBe("pre");
    expect(result.code).toContain("props: Props");
    expect(result.code).toContain('get "title"()');
    expect(result.code).toContain("() => props.count");
    expect(result.code).not.toContain("<button");
    expect(result.map?.sources).toContain("/project/src/Counter.tsx");
    expect(result.map?.sourcesContent).toContain(source);
    expect(result.map?.mappings.length).toBeGreaterThan(0);
  });

  it("supports JSX and forwards compiler options", () => {
    const result = virentiaUI({ importSource: "custom-ui" }).transform(
      `export const View = () => <><span>hello</span></>;`,
      "/project/src/View.jsx",
    )!;
    expect(result.code).toContain('from "custom-ui"');
    expect(result.code).toContain("Fragment");
  });

  it("leaves dependencies, non-code files and query modules untouched", () => {
    const plugin = virentiaUI();
    for (const id of [
      "/project/node_modules/dependency/index.tsx",
      "C:\\project\\node_modules\\dependency\\index.jsx",
      "/project/src/style.css",
      "/project/src/image.svg",
      "/project/src/View.tsx?raw",
      "/project/src/View.jsx?url",
    ]) {
      expect(plugin.transform("not parseable source", id)).toBeNull();
    }
  });

  it("does not rewrite JSX owned by React or explicitly excluded modules", () => {
    const reactSource = `/** @jsxImportSource react */ export const View = () => <button>React</button>;`;
    const vueSource = `/** @jsxImportSource vue */ export const View = () => <button>Vue</button>;`;
    const plugin = virentiaUI({ exclude: /\/foreign\// });
    expect(plugin.transform(reactSource, "/project/src/react/View.tsx")).toBeNull();
    expect(plugin.transform(vueSource, "/project/src/vue/View.tsx")).toBeNull();
    expect(plugin.transform("export const x = 1", "/project/src/foreign/model.ts")).toBeNull();
    expect(plugin.transform("export const x = 1", "/project/src/model.ts")).not.toBeNull();
  });

  it("instruments plain TS/JS modules with the same root-relative SID in both builds", () => {
    const source = `import { store, event } from "@virentia/ui";
      export const count = store(0); export const clicked = event("clicked");`;
    const server = virentiaUI({ namespace: "app" });
    const client = virentiaUI({ namespace: "app" });
    server.configResolved({ root: "/srv/build" });
    client.configResolved({ root: "/home/project" });
    const serverCode = server.transform(source, "/srv/build/src/model.ts")!.code;
    const clientCode = client.transform(source, "/home/project/src/model.ts")!.code;
    expect(serverCode).toBe(clientCode);
    expect(serverCode).toContain("sid:");
    expect(serverCode).toContain("v1:app:src%2Fmodel.ts:");
    expect(serverCode).toMatch(/event\("clicked", \{\s*sid: "v1:app:src%2Fmodel.ts:/);
    expect(client.transform(source, "/home/project/src/model.js")!.code).toContain("sid:");
  });

  it("preserves TS-only syntax and honors explicit root/SID opt-out", () => {
    const source = `import { store } from "@virentia/core";
      const initial = <number>0; export const count = store(initial);`;
    const plugin = virentiaUI({ root: "/repo" });
    plugin.configResolved({ root: "/repo/app" });
    expect(plugin.transform(source, "/repo/app/model.ts")!.code).toContain("v1::app%2Fmodel.ts:");
    expect(virentiaUI({ sid: false }).transform(source, "/repo/app/model.ts")!.code).not.toContain(
      "sid:",
    );
  });
});

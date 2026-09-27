import { describe, expect, it } from "vitest";
import virentiaCore from "../../compiler/vite";

function sids(code: string): string[] {
  return Array.from(code.matchAll(/sid: "([^"]+)"/g), (match) => match[1]);
}

describe("@virentia/core/compiler/vite", () => {
  it("uses Vite's root to make server/client SIDs match and returns a source map", () => {
    const source = `import { store, event } from "@virentia/core";
      const count = store(0);
      const changed = event("changed");`;
    const server = virentiaCore({ namespace: "app" });
    server.configResolved({ root: "/srv/build" });
    const client = virentiaCore({ namespace: "app" });
    client.configResolved({ root: "/home/project" });

    const serverResult = server.transform(source, "/srv/build/src/model.ts");
    const clientResult = client.transform(source, "/home/project/src/model.ts");
    expect(serverResult).not.toBeNull();
    expect(clientResult).not.toBeNull();
    expect(sids(serverResult!.code)).toEqual(sids(clientResult!.code));
    expect(sids(serverResult!.code)).toHaveLength(2);
    expect(serverResult!.map?.version).toBe(3);
    expect(serverResult!.map?.sources).toContain("/srv/build/src/model.ts");
  });

  it("preserves React-authored JSX and is idempotent with another SID pass", () => {
    const source = `import { event } from "@virentia/core";
      const clicked = event("clicked");
      export const Button = () => <button onClick={() => clicked()}>Click</button>;`;
    const plugin = virentiaCore({ root: "/project" });
    const once = plugin.transform(source, "/project/src/Button.tsx");
    expect(once?.code).toContain("<button");
    expect(sids(once!.code)).toHaveLength(1);
    const twice = plugin.transform(once!.code, "/project/src/Button.tsx");
    expect(sids(twice!.code)).toEqual(sids(once!.code));
  });

  it("honors explicit root and opt-out, and skips non-app modules", () => {
    const source = `import { store } from "@virentia/core"; store(0);`;
    const plugin = virentiaCore({ root: "/explicit", namespace: "shared" });
    plugin.configResolved({ root: "/other" });
    const result = plugin.transform(source, "/explicit/src/a.js");
    expect(sids(result!.code)[0]).toContain("src%2Fa.js");
    expect(sids(result!.code)[0]).toContain("shared");
    expect(plugin.transform(source, "/explicit/node_modules/pkg/a.js")).toBeNull();
    expect(plugin.transform(source, "/explicit/src/a.js?raw")).toBeNull();
    expect(plugin.transform(source, "/explicit/src/a.css")).toBeNull();
    expect(plugin.transform(source, "/explicit/src/a.d.ts")).toBeNull();
    expect(plugin.transform("export const value = 1;", "/explicit/src/plain.js")).toBeNull();
    expect(virentiaCore({ sid: false }).transform(source, "/explicit/src/a.js")).toBeNull();
  });
});

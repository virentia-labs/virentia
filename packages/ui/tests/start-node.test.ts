// @vitest-environment node

import { once } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createStartServer } from "../start/node";

const roots: string[] = [];
const validManifest = {
  "virtual:virentia-start/client": { file: "assets/client.js", isEntry: true },
};

class MemoryResponse extends Writable {
  statusCode = 200;
  readonly headers = new Map<string, string>();
  readonly chunks: Buffer[] = [];

  setHeader(name: string, value: string | number) {
    this.headers.set(name.toLowerCase(), String(value));
    return this;
  }

  writeHead(statusCode: number, headers?: Record<string, string | number>) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value);
    return this;
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function fixture(manifest: unknown = validManifest, serverSource?: string) {
  const root = await mkdtemp(join(tmpdir(), "virentia-start-node-"));
  roots.push(root);
  const clientDir = resolve(root, "dist/client");
  await mkdir(resolve(clientDir, ".vite"), { recursive: true });
  await mkdir(resolve(root, "dist/server"), { recursive: true });
  await writeFile(resolve(clientDir, ".vite/manifest.json"), JSON.stringify(manifest));
  await writeFile(
    resolve(root, "dist/server/entry-server.mjs"),
    serverSource ??
      `export const documentTitle = "Built <Title>";
export async function renderRequest(url) {
  return { html: "<main>Rendered page</main>", payload: JSON.stringify({ url }) };
}`,
  );
  return { root, clientDir };
}

async function request(
  server: Server,
  url: string,
  options: { method?: string; accept?: string } = {},
): Promise<MemoryResponse> {
  const response = new MemoryResponse();
  const incoming = {
    url,
    method: options.method ?? "GET",
    headers: options.accept ? { accept: options.accept } : {},
  } as IncomingMessage;
  const handler = server.listeners("request")[0] as (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>;
  const finished = once(response, "finish");
  await Promise.all([handler(incoming, response as unknown as ServerResponse), finished]);
  return response;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("built Start server", () => {
  it("loads the entry, resolves imported assets, and renders the requested URL", async () => {
    const { root } = await fixture({
      client: {
        file: "assets/client.js",
        isEntry: true,
        css: ["assets/app.css"],
        imports: ["shared", "other"],
      },
      shared: {
        file: "assets/shared.js",
        css: ["assets/shared.css"],
        imports: ["other"],
      },
      other: {
        file: "assets/other.js",
        css: ["assets/shared.css"],
        imports: ["shared"],
      },
    });
    const server = await createStartServer({ root });
    const response = await request(server, "/people/ada?hello=Hi%20Ada", {
      accept: "text/html",
    });
    const html = response.body();

    expect(response.statusCode).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain("<title>Built &lt;Title&gt;</title>");
    expect(html).toContain('src="/assets/client.js"');
    expect(html).toContain('href="/assets/app.css"');
    expect(html).toContain('href="/assets/shared.css"');
    expect(html).toContain('rel="modulepreload" href="/assets/shared.js"');
    expect(html).toContain('rel="modulepreload" href="/assets/other.js"');
    expect(html.match(/href="\/assets\/shared.css"/g)).toHaveLength(1);
    expect(html.match(/rel="modulepreload"/g)).toHaveLength(2);
    expect(html).toContain('{"url":"/people/ada?hello=Hi%20Ada"}');
  });

  it("serves decoded static paths with content headers and handles HEAD without a body", async () => {
    const { root, clientDir } = await fixture();
    await mkdir(resolve(clientDir, "assets"));
    await writeFile(resolve(clientDir, "assets/client.js"), "export const value = 42;");
    await writeFile(resolve(clientDir, "theme light.css"), "body { color: red; }");
    const server = await createStartServer({ root });

    const asset = await request(server, "/assets/client.js");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(asset.body()).toBe("export const value = 42;");

    const head = await request(server, "/assets/client.js", { method: "HEAD" });
    expect(head.statusCode).toBe(200);
    expect(head.headers.get("content-length")).toBe(String("export const value = 42;".length));
    expect(head.body()).toBe("");

    const stylesheet = await request(server, "/theme%20light.css");
    expect(stylesheet.statusCode).toBe(200);
    expect(stylesheet.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(stylesheet.headers.get("cache-control")).toBe("no-cache");
    expect(stylesheet.body()).toBe("body { color: red; }");
  });

  it("rejects malformed and escaping paths, and does not turn missing assets into pages", async () => {
    const { root, clientDir } = await fixture();
    await mkdir(resolve(clientDir, "assets"));
    await writeFile(resolve(root, "dist/secret.txt"), "outside client root");
    const server = await createStartServer({ root });

    expect((await request(server, "/%zz")).statusCode).toBe(400);
    expect((await request(server, "/%00")).statusCode).toBe(400);
    expect((await request(server, "/%2e%2e%2fsecret.txt")).statusCode).toBe(403);
    expect((await request(server, "/missing.js")).statusCode).toBe(404);
    expect((await request(server, "/page", { accept: "application/json" })).statusCode).toBe(404);
    expect((await request(server, "/page", { method: "POST" })).statusCode).toBe(404);
  });

  it("does not serve a symlink to a file outside the client directory", async () => {
    const { root, clientDir } = await fixture();
    await mkdir(resolve(clientDir, "assets"));
    const secret = resolve(root, "secret.txt");
    await writeFile(secret, "outside client root");
    await symlink(secret, resolve(clientDir, "assets/linked.txt"));
    const server = await createStartServer({ root });

    const response = await request(server, "/assets/linked.txt");
    expect(response.statusCode).not.toBe(200);
    expect(response.body()).not.toContain("outside client root");
  });

  it.each([
    ["no entry", {}, "Expected one client entry in Vite manifest, found 0"],
    [
      "multiple entries",
      { a: { file: "a.js", isEntry: true }, b: { file: "b.js", isEntry: true } },
      "Expected one client entry in Vite manifest, found 2",
    ],
    [
      "missing import",
      { a: { file: "a.js", isEntry: true, imports: ["missing"] } },
      "Missing Vite manifest import: missing",
    ],
    [
      "absolute entry path",
      { a: { file: "/outside.js", isEntry: true } },
      "Invalid built asset path: /outside.js",
    ],
    [
      "parent segment in entry",
      { a: { file: "assets/../outside.js", isEntry: true } },
      "Invalid built asset path: assets/../outside.js",
    ],
    [
      "parent segment in stylesheet",
      { a: { file: "a.js", isEntry: true, css: ["../outside.css"] } },
      "Invalid built asset path: ../outside.css",
    ],
    [
      "parent segment in imported chunk",
      { a: { file: "a.js", isEntry: true, imports: ["chunk"] }, chunk: { file: "../outside.js" } },
      "Invalid built asset path: ../outside.js",
    ],
  ])("rejects a manifest with %s", async (_name, manifest, message) => {
    const { root } = await fixture(manifest);
    await expect(createStartServer({ root })).rejects.toThrow(message);
  });

  it("requires renderRequest in the built server entry", async () => {
    const { root } = await fixture(validManifest, 'export const documentTitle = "No renderer";');
    await expect(createStartServer({ root })).rejects.toThrow(
      "Built server entry does not export renderRequest",
    );
  });
});

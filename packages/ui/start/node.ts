import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { RenderedPage } from "./runtime";
import { renderDocument } from "./document";

interface ManifestEntry {
  file: string;
  isEntry?: boolean;
  css?: string[];
  imports?: string[];
}

type ClientManifest = Record<string, ManifestEntry>;

interface ServerEntry {
  documentTitle?: string;
  renderRequest(url: string, request: IncomingMessage): Promise<RenderedPage>;
}

export interface StartBuildOptions {
  /** Directory containing vite.config.ts. Defaults to the current directory. */
  root?: string;
  configFile?: string;
}

export interface StartServeOptions extends StartBuildOptions {
  host?: string;
  port?: number;
}

/** Build the browser bundle and the single-page SSR entry with one Vite config. */
export async function buildStart(options: StartBuildOptions = {}): Promise<void> {
  const root = resolve(options.root ?? process.cwd());
  const configFile = resolve(root, options.configFile ?? "vite.config.ts");
  const { build } = await import("vite");

  await build({
    root,
    configFile,
    build: {
      outDir: resolve(root, "dist/client"),
      emptyOutDir: true,
    },
  });
  await build({
    root,
    configFile,
    build: {
      ssr: true,
      outDir: resolve(root, "dist/server"),
      emptyOutDir: true,
      rolldownOptions: {
        input: "virtual:virentia-start/server",
        output: { entryFileNames: "entry-server.mjs" },
      },
    },
  });
}

/** Serve the built one-page application with Node's HTTP server. */
export async function createStartServer(options: StartServeOptions = {}): Promise<Server> {
  const root = resolve(options.root ?? process.cwd());
  const clientDir = resolve(root, "dist/client");
  const realClientDir = await realpath(clientDir);
  const serverEntryPath = resolve(root, "dist/server/entry-server.mjs");
  const manifestPath = resolve(clientDir, ".vite/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ClientManifest;
  const assets = clientAssets(manifest);
  const entry = (await import(pathToFileURL(serverEntryPath).href)) as ServerEntry;
  if (typeof entry.renderRequest !== "function") {
    throw new TypeError("[ui/start] Built server entry does not export renderRequest");
  }

  return createServer(async (request, response) => {
    const url = request.url ?? "/";
    const pathname = new URL(url, "http://localhost").pathname;
    if (await serveStatic(request, response, clientDir, realClientDir, pathname)) return;
    if (!isPageRequest(request, pathname)) {
      response.writeHead(404).end();
      return;
    }

    try {
      const page = await entry.renderRequest(url, request);
      const html = renderDocument(page, {
        title: entry.documentTitle,
        clientEntryUrl: assets.entry,
        stylesheets: assets.stylesheets,
        modulePreloads: assets.modulePreloads,
      });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : html);
    } catch (error) {
      if (error instanceof Response) {
        response.statusCode = error.status;
        error.headers.forEach((value, key) => response.setHeader(key, value));
        response.end(request.method === "HEAD" ? undefined : await error.text());
        return;
      }
      console.error("[ui/start] Request failed", error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : "Internal Server Error");
    }
  });
}

/** Build and start the HTTP listener; returns it for graceful shutdown. */
export async function serveStart(options: StartServeOptions = {}): Promise<Server> {
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("[ui/start] port must be an integer from 0 to 65535");
  }
  const host = options.host ?? "127.0.0.1";
  const server = await createStartServer(options);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  return server;
}

function clientAssets(manifest: ClientManifest): {
  entry: string;
  stylesheets: string[];
  modulePreloads: string[];
} {
  const entries = Object.values(manifest).filter((item) => item.isEntry);
  if (entries.length !== 1) {
    throw new Error(
      `[ui/start] Expected one client entry in Vite manifest, found ${entries.length}`,
    );
  }
  const stylesheets = new Set<string>();
  const modulePreloads = new Set<string>();
  const visited = new Set<string>();
  const visit = (entry: ManifestEntry) => {
    for (const css of entry.css ?? []) stylesheets.add(assetUrl(css));
    for (const key of entry.imports ?? []) {
      if (visited.has(key)) continue;
      visited.add(key);
      const imported = manifest[key];
      if (!imported) throw new Error(`[ui/start] Missing Vite manifest import: ${key}`);
      modulePreloads.add(assetUrl(imported.file));
      visit(imported);
    }
  };
  visit(entries[0]);
  return {
    entry: assetUrl(entries[0].file),
    stylesheets: [...stylesheets],
    modulePreloads: [...modulePreloads],
  };
}

function assetUrl(file: string): string {
  if (file.startsWith("/") || file.split("/").includes("..")) {
    throw new Error(`[ui/start] Invalid built asset path: ${file}`);
  }
  return `/${file}`;
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  directory: string,
  realDirectory: string,
  pathname: string,
): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end();
    return true;
  }
  if (decoded.includes("\0")) {
    response.writeHead(400).end();
    return true;
  }
  const file = resolve(directory, `.${decoded}`);
  if (file !== directory && !file.startsWith(`${directory}${sep}`)) {
    response.writeHead(403).end();
    return true;
  }
  let actualFile: string;
  try {
    actualFile = await realpath(file);
  } catch {
    return false;
  }
  if (actualFile !== realDirectory && !actualFile.startsWith(`${realDirectory}${sep}`)) {
    response.writeHead(403).end();
    return true;
  }
  const info = await stat(actualFile);
  if (!info.isFile()) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return true;
  }
  response.writeHead(200, {
    "Content-Type": mimeType(actualFile),
    "Content-Length": info.size,
    "Cache-Control": actualFile.includes(`${sep}assets${sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(actualFile).pipe(response);
  return true;
}

function isPageRequest(request: IncomingMessage, pathname: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (extname(pathname)) return false;
  const accept = request.headers.accept;
  return !accept || accept.includes("text/html") || accept.includes("*/*");
}

function mimeType(file: string): string {
  switch (extname(file)) {
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { installVirentiaInspectorRelay } from "./relay";

const args = parseArgs({
  allowPositionals: false,
  options: {
    help: {
      short: "h",
      type: "boolean",
    },
    host: {
      default: "127.0.0.1",
      type: "string",
    },
    open: {
      short: "o",
      type: "boolean",
    },
    port: {
      default: "5174",
      short: "p",
      type: "string",
    },
  },
});

if (args.values.help) {
  printHelp();
  process.exit(0);
}

const host = args.values.host ?? "127.0.0.1";
const port = Number(args.values.port ?? 5174);
const appDir = fileURLToPath(new URL("./app/", import.meta.url));

if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  console.error(`[virentia-inspector] Invalid port: ${args.values.port}`);
  process.exit(1);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const filePath = resolveFile(pathname);

  if (!filePath) {
    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": contentType(filePath),
  });
  createReadStream(filePath).pipe(response);
});
const closeRelay = installVirentiaInspectorRelay(server);

server.on("error", (error: NodeJS.ErrnoException) => {
  closeRelay();

  if (error.code === "EADDRINUSE") {
    console.error(`[virentia-inspector] ${host}:${port} is already in use.`);
  } else {
    console.error(`[virentia-inspector] ${error.message}`);
  }

  process.exit(1);
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}/`;

  console.log(`Virentia inspector is running at ${url}`);
  console.log("Use installVirentiaDevtools({ autoOpen: true }) in your app.");

  if (args.values.open) {
    openBrowser(url);
  }
});

function resolveFile(pathname: string): string | null {
  const root = resolve(appDir);
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const target = resolve(root, `.${cleanPath}`);

  if (!target.startsWith(root)) {
    return null;
  }

  if (existsSync(target)) {
    const stat = statSync(target);

    if (stat.isFile()) {
      return target;
    }

    if (stat.isDirectory()) {
      const index = resolve(target, "index.html");

      return existsSync(index) ? index : null;
    }
  }

  const fallback = resolve(root, "index.html");

  return existsSync(fallback) ? fallback : null;
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function openBrowser(url: string): void {
  void import("node:child_process").then(({ spawn }) => {
    const command =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });

    child.unref();
  });
}

function printHelp(): void {
  console.log(`Virentia inspector

Usage:
  virentia-inspector [--host 127.0.0.1] [--port 5174] [--open]

Options:
  -h, --help     Show help
  --host         Host to listen on, default 127.0.0.1
  -p, --port     Port to listen on, default 5174
  -o, --open     Open the inspector URL in the system browser
`);
}

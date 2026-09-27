import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import virentiaCore from "@virentia/core/compiler/vite";
import { normalizePath, type Plugin } from "vite";
import virentiaUI from "../compiler/vite";
import { renderDocument } from "./document";

const clientId = "virtual:virentia-start/client";
const serverId = "virtual:virentia-start/server";
const resolvedClientId = `\0${clientId}`;
const resolvedServerId = `\0${serverId}`;
const clientUrl = `/@id/__x00__${clientId}`;
const rootElementId = "virentia-start-root";
const payloadElementId = "virentia-start-payload";

export interface StartOptions {
  /** Default: app.tsx in Vite's root. */
  app?: string;
  /** Default: load.server.ts in Vite's root, if present. */
  load?: string;
  /** Stable across server render and browser hydration. Default: app. */
  identifierPrefix?: string;
  /** HTML document title. Default: Virentia. */
  title?: string;
  /** Namespace for compiler-generated store SIDs. Default: app. */
  namespace?: string;
}

interface RenderedPage {
  html: string;
  payload: string;
}

interface ServerEntry {
  documentTitle: string;
  renderRequest(url: string, request: IncomingMessage): Promise<RenderedPage>;
}

/** One-page SSR convention: app.tsx and optional load.server.ts. */
export default function virentiaStart(options: StartOptions = {}): Plugin[] {
  let root = "";
  const identifierPrefix = options.identifierPrefix ?? "app";
  const title = options.title ?? "Virentia";

  const start: Plugin = {
    name: "virentia-start",
    config(_config, environment) {
      return {
        appType: "custom",
        ...(environment.command === "build" && !environment.isSsrBuild
          ? {
              build: {
                rolldownOptions: { input: clientId },
                manifest: true,
              },
            }
          : {}),
      };
    },
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      if (id === clientId) return resolvedClientId;
      if (id === serverId) return resolvedServerId;
      return null;
    },
    load(id) {
      const appPath = normalizePath(resolve(root, options.app ?? "app.tsx"));
      if (id === resolvedClientId) {
        return `import App from ${JSON.stringify(appPath)};
import { createElement } from "@virentia/ui";
import { hydratePage } from "@virentia/ui/start";
const root = document.getElementById(${JSON.stringify(rootElementId)});
const payload = document.getElementById(${JSON.stringify(payloadElementId)})?.textContent;
if (!root || !payload) throw new Error("[ui/start] Missing hydration root or payload");
const page = hydratePage((data) => createElement(App, { data }), root, payload);
if (import.meta.hot) import.meta.hot.dispose(page.dispose);
`;
      }
      if (id === resolvedServerId) {
        const loadPath = normalizePath(resolve(root, options.load ?? "load.server.ts"));
        const load = existsSync(loadPath)
          ? `import load from ${JSON.stringify(loadPath)};`
          : "const load = () => null;";
        return `import App from ${JSON.stringify(appPath)};
import { createElement } from "@virentia/ui";
import { renderPageAsync } from "@virentia/ui/start";
${load}
export const documentTitle = ${JSON.stringify(title)};
export async function renderRequest(requestUrl, request) {
  const url = new URL(requestUrl, "http://localhost");
  const data = await load({ url, request });
  return await renderPageAsync((data) => createElement(App, { data }), data, {
    identifierPrefix: ${JSON.stringify(identifierPrefix)},
  });
}
`;
      }
      return null;
    },
    configureServer(server) {
      return () => {
        server.middlewares.use(async (request, response, next) => {
          if (!isPageRequest(request)) {
            next();
            return;
          }
          const url = request.originalUrl ?? request.url ?? "/";
          try {
            const entry = (await server.ssrLoadModule(serverId)) as ServerEntry;
            const page = await entry.renderRequest(url, request);
            const document = await server.transformIndexHtml(
              url,
              renderDocument(page, { title, clientEntryUrl: clientUrl }),
            );
            response.statusCode = 200;
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end(request.method === "HEAD" ? undefined : document);
          } catch (error) {
            if (error instanceof Response) {
              response.statusCode = error.status;
              error.headers.forEach((value, key) => response.setHeader(key, value));
              response.end(request.method === "HEAD" ? undefined : await error.text());
              return;
            }
            if (error instanceof Error) server.ssrFixStacktrace(error);
            next(error);
          }
        });
      };
    },
  };

  const namespace = options.namespace ?? "app";
  return [virentiaCore({ namespace }), virentiaUI({ namespace }), start];
}

function isPageRequest(request: IncomingMessage): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const url = request.url ?? "/";
  const pathname = new URL(url, "http://localhost").pathname;
  if (/^\/(?:@|__vite|node_modules\/)/.test(pathname)) return false;
  const accept = request.headers.accept;
  if (accept && !accept.includes("text/html") && !accept.includes("*/*")) return false;
  if (/\.(?:css|js|mjs|map|json|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)$/i.test(pathname))
    return false;
  return true;
}

/** @jsxImportSource @virentia/ui */
import { scope, serialize } from "@virentia/core";
import { renderToString, serializeState } from "@virentia/ui/server";
import { App } from "./App";
import { identifierPrefix } from "./configuration";

/** Each invocation owns its scope; no mutable request state is stored globally. */
export function renderDocument(requestUrl: string): string {
  const requested = new URL(requestUrl, "http://localhost").searchParams.get("count");
  const initialCount = requested && /^\d{1,3}$/.test(requested) ? Number(requested) : 7;
  const requestScope = scope();
  const html = renderToString(() => <App initialCount={initialCount} />, {
    scope: requestScope,
    identifierPrefix,
  });
  const snapshot = serializeState(serialize(requestScope));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Virentia UI — SSR + hydration</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <div id="app">${html}</div>
    <footer id="hydration-status" role="status">Server-rendered HTML · waiting for hydration</footer>
    <script id="virentia-state" type="application/json">${snapshot}</script>
    <script type="module" src="/entry-client.tsx"></script>
  </body>
</html>`;
}

import type { RenderedPage } from "./runtime";

export interface DocumentOptions {
  clientEntryUrl: string;
  title?: string;
  stylesheets?: readonly string[];
  modulePreloads?: readonly string[];
}

/** Wrap rendered page HTML and state using dev or built asset URLs. */
export function renderDocument(page: RenderedPage, options: DocumentOptions): string {
  const title = options.title ?? "Virentia";
  const stylesheets = (options.stylesheets ?? [])
    .map((url) => `    <link rel="stylesheet" href="${escapeHtml(url)}" />`)
    .join("\n");
  const modulePreloads = (options.modulePreloads ?? [])
    .map((url) => `    <link rel="modulepreload" href="${escapeHtml(url)}" />`)
    .join("\n");
  const assets = [stylesheets, modulePreloads].filter(Boolean).join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>${assets ? `\n${assets}` : ""}
  </head>
  <body>
    <div id="virentia-start-root">${page.html}</div>
    <script id="virentia-start-payload" type="application/json">${page.payload}</script>
    <script type="module" src="${escapeHtml(options.clientEntryUrl)}"></script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

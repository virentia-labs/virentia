/** @jsxImportSource @virentia/ui */
import { scope, type ScopeSnapshot } from "@virentia/core";
import { hydrate } from "@virentia/ui";
import { App } from "./App";
import { identifierPrefix } from "./configuration";

const container = document.getElementById("app")!;
const snapshot = JSON.parse(
  document.getElementById("virentia-state")!.textContent!,
) as ScopeSnapshot;
const originalNodes = Array.from(container.querySelectorAll("button, input, output, textarea"));
const originalIds = Array.from(container.querySelectorAll("input"), (input) => input.id);
const clientScope = scope({ snapshot });

const dispose = hydrate(() => <App />, container, { scope: clientScope, identifierPrefix });
const currentNodes = Array.from(container.querySelectorAll("button, input, output, textarea"));
const retained =
  originalNodes.length === currentNodes.length &&
  originalNodes.every((node, index) => currentNodes[index] === node);
const idsMatch = originalIds.every(
  (id, index) => container.querySelectorAll("input")[index]?.id === id,
);

container.dataset.hydrated = "true";
container.dataset.nodesRetained = String(retained);
container.dataset.idsMatch = String(idsMatch);
const formTextMatches =
  container.querySelector<HTMLTextAreaElement>("#ssr-notes")!.value === "\nNotes <&\nsecond line";
container.dataset.formTextMatches = String(formTextMatches);
document.getElementById("hydration-status")!.textContent =
  retained && idsMatch && formTextMatches
    ? "Hydrated · original DOM retained · server/client IDs match · form text verified"
    : "Hydration finished, but a DOM identity check failed";

if (import.meta.hot) import.meta.hot.dispose(dispose);

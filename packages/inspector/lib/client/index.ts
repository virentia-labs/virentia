import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VirentiaInspector, type VirentiaInspectorProps } from "./modules/inspector";

export { VirentiaInspector };
export type { VirentiaInspectorProps };

export function mountVirentiaInspector(
  container: Element | DocumentFragment,
  props: VirentiaInspectorProps = {},
): Root {
  const root = createRoot(container);

  root.render(createElement(VirentiaInspector, props));

  return root;
}

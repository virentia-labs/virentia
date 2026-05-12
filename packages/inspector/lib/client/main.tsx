import "./shared/ui/public/styles.css";

import { mountVirentiaInspector } from "./index";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Virentia inspector root element is missing");
}

mountVirentiaInspector(root);

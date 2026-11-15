import { createElement as nativeH, render, scope } from "@virentia/ui";
import { asReact } from "@virentia/ui/react";
import { asVue } from "@virentia/ui/vue";
import { ScopeProvider as ReactScope } from "@virentia/react";
import { ScopeProvider as VueScope } from "@virentia/vue";
import { createElement as reactH, useState } from "react";
import { createRoot } from "react-dom/client";
import { createApp, h as vueH, ref } from "vue";
import { Counter } from "./Counter.ui";
import "./style.css";

const appScope = scope();
const disposeNative = render(
  () => nativeH(Counter, { id: "native", label: "Native" }),
  document.getElementById("native")!,
  { scope: appScope, identifierPrefix: "native-demo" },
);

const ReactCounter = asReact(Counter);
function ReactPanel() {
  const [label, setLabel] = useState("React");
  return reactH(
    ReactScope,
    { scope: appScope },
    reactH(
      "div",
      { className: "row" },
      reactH(ReactCounter, { id: "react", label }),
      reactH(
        "button",
        {
          id: "react-props",
          onClick: () => setLabel(label === "React" ? "Updated React" : "React"),
        },
        "Change props",
      ),
    ),
  );
}
const reactRoot = createRoot(document.getElementById("react")!);
reactRoot.render(reactH(ReactPanel));

const VueCounter = asVue(Counter);
const vueApp = createApp({
  setup() {
    const label = ref("Vue");
    return () =>
      vueH(
        VueScope,
        { scope: appScope },
        {
          default: () =>
            vueH("div", { class: "row" }, [
              vueH(VueCounter, { id: "vue", label: label.value }),
              vueH(
                "button",
                {
                  id: "vue-props",
                  onClick: () => {
                    label.value = label.value === "Vue" ? "Updated Vue" : "Vue";
                  },
                },
                "Change props",
              ),
            ]),
        },
      );
  },
});
vueApp.mount(document.getElementById("vue")!);

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    disposeNative();
    reactRoot.unmount();
    vueApp.unmount();
  });

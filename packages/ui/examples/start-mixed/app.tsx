/** @jsxImportSource @virentia/ui */
import { store } from "@virentia/ui";
import { ReactTree } from "@virentia/ui/react";
import { VueTree } from "@virentia/ui/vue";
import { useUnit as useReactUnit } from "@virentia/react";
import { useUnit as useVueUnit } from "@virentia/vue";
import { createElement as reactH } from "react";
import { defineComponent, h as vueH } from "vue";

const count = store(0);

function ReactCounter() {
  const value = useReactUnit(count);
  return reactH("p", { "data-renderer": "react" }, `React: ${value}`);
}

const VueCounter = defineComponent({
  setup() {
    const value = useVueUnit(count);
    return () => vueH("p", { "data-renderer": "vue" }, `Vue: ${value.value}`);
  },
});

export default function App({ data }: { data: { count: number } }) {
  count.value = data.count;

  return (
    <main>
      <h1>One scope, three renderers</h1>
      <button onClick={() => count.value++}>Virentia: {count.value}</button>
      <ReactTree node={reactH(ReactCounter)} />
      <VueTree node={vueH(VueCounter)} />
    </main>
  );
}

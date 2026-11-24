/** @jsxImportSource @virentia/ui */
import { staticModel, f } from "@virentia/core/models";
import { component, type View } from "../../lib";
const Model = staticModel({ data: { visible: f.boolean(true) } });
const App = component({ model: Model, view: (_props, self) => {
  const details: View = () => self.model.visible.value ? <aside /> : null;
  return <main>{details}</main>;
} });
<App />;

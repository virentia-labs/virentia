import { expect, it } from "vitest";
import { scope, scoped, store } from "@virentia/core";
import { f, staticModel } from "@virentia/core/models";
import { component, createContext, For, h, hydrate, Portal, render, type Readable } from "@virentia/ui";
import { renderToString } from "@virentia/ui/server";

it("hydrates native lists and context without host adapters and preserves independent roots", async () => {
  const Theme = createContext("default");
  const theme = store("light"), items = store(["a", "b"]);
  const Row = component({
    model: staticModel({ name: "NativeFeatureRow", data: { label: f.string() } }),
    view(_props, self) {
      return h("li", null, self.model.label, ":", self.context(Theme));
    },
  });
  const view = () => h(Theme.Provider, { value: theme }, h("ul", null, h(For, {
    each: items,
    view: (item: Readable<string>) => h(Row, { id: item.value, label: item }),
  })));
  const server = scope(), first = scope(), second = scope();
  scoped(server, () => { theme.value = "dark"; });
  scoped(first, () => { theme.value = "dark"; });
  const host = document.createElement("div"), other = document.createElement("div");
  host.innerHTML = renderToString(view, { scope: server, identifierPrefix: "native-features" });
  const rows = [...host.querySelectorAll("li")];
  const detach = hydrate(view, host, { scope: first, identifierPrefix: "native-features" });
  const detachOther = render(view, other, { scope: second });
  try {
    expect([...host.querySelectorAll("li")]).toEqual(rows);
    rows.forEach((row, index) => expect(host.querySelectorAll("li")[index]).toBe(row));
    expect(host.textContent).toBe("a:darkb:dark");
    expect(other.textContent).toBe("a:lightb:light");
    scoped(first, () => { theme.value = "blue"; });
    expect(host.textContent).toBe("a:blueb:blue");
    expect(host.querySelector("li")).toBe(rows[0]);
    expect(other.textContent).toBe("a:lightb:light");
    scoped(first, () => { items.value = ["c"]; });
    expect(host.textContent).toBe("c:blue");
    expect(other.textContent).toBe("a:lightb:light");
  } finally {
    await detach();
    await detachOther();
    expect(host.childNodes).toHaveLength(0);
    expect(other.childNodes).toHaveLength(0);
  }
});

it("owns portal updates and disposal in each application scope", async () => {
  const value = store("initial"), first = scope(), second = scope();
  const host = document.createElement("div"), target = document.createElement("div");
  const otherHost = document.createElement("div"), otherTarget = document.createElement("div");
  const detach = render(() => h(Portal, { mount: target }, h("span", null, value)), host, { scope: first });
  const detachOther = render(() => h(Portal, { mount: otherTarget }, h("span", null, value)), otherHost, { scope: second });
  const span = target.querySelector("span")!;
  try {
    scoped(first, () => { value.value = "updated"; });
    expect(target.textContent).toBe("updated");
    expect(target.querySelector("span")).toBe(span);
    expect(otherTarget.textContent).toBe("initial");
    await detach();
    expect(host.childNodes).toHaveLength(0);
    expect(target.childNodes).toHaveLength(0);
    scoped(first, () => { value.value = "detached"; });
    expect(span.textContent).toBe("updated");
    scoped(second, () => { value.value = "independent"; });
    expect(otherTarget.textContent).toBe("independent");
  } finally {
    await detach();
    await detachOther();
    expect(otherHost.childNodes).toHaveLength(0);
    expect(otherTarget.childNodes).toHaveLength(0);
  }
});

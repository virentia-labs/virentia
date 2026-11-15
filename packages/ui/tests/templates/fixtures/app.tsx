/** @jsxImportSource @virentia/ui */
// Mounted twice by tests/templates/dom.test.ts: as the JSX runtime's output and
// compiled into templates. Every scenario must behave identically either way.
import { computed, event, reaction, store } from "@virentia/core";
import { resolveStoreSid } from "@virentia/core/internal";
import { f, staticModel } from "@virentia/core/models";
import { mutableStore } from "@virentia/mutable";
import { action, component, For, ref, ui } from "@virentia/ui";
import type { Child, Readable } from "@virentia/ui";
import { contextualElementId } from "../../../lib/runtime";

export interface Scenario {
  view: () => Child;
  steps?: ((container: HTMLElement) => unknown)[];
  /** Observations besides the DOM, read after each step. */
  probe?: (container: HTMLElement) => unknown;
  /** Rendered on the server too, then hydrated. */
  server?: boolean;
}

const statics = (): Scenario => ({
  server: true,
  view: () => (
    <section
      id="s"
      class="a b"
      data-x="1"
      aria-label="L"
      title="t &amp; q"
      hidden={false}
      tabIndex={0}
    >
      <h1 style="color: red">Title &copy; 2026</h1>
      <p>
        Some text
        <b>bold</b> and <i>italic</i>{" "}
        <span class="x" className="y">
          after
        </span>
      </p>
      <svg viewBox="0 0 10 10" width="10">
        <g strokeWidth="2" fillOpacity={0.5}>
          <path d="M0 0L10 10" />
          <a href="#t">
            <text x="1">t</text>
          </a>
          <use xlink:href="#t" />
        </g>
      </svg>
      <input type="checkbox" checked value="v" disabled />
      <input autofocus type="text" defaultValue="d" />
      <label for="i" htmlFor="j">
        label
      </label>
      <br />
      <ul>
        {null}
        {false}
        {0}
        {"text"}
        <li>one</li>
        {``}
      </ul>
      <table>
        <tbody>
          <tr>
            <td colSpan={2}>cell</td>
          </tr>
        </tbody>
      </table>
    </section>
  ),
});

// happy-dom's parser keeps neither HTML inside <foreignObject> nor MathML
// apart: client only.
const foreign = (): Scenario => ({
  view: () => (
    <div>
      <svg>
        <foreignObject>
          <div class="fo">
            html <b>in</b> svg <svg width="1" />
          </div>
        </foreignObject>
        <g />
      </svg>
      {/* @ts-expect-error MathML elements have no JSX types */}
      <math>
        {/* @ts-expect-error */}
        <mi>x</mi>
        {/* @ts-expect-error */}
      </math>
    </div>
  ),
});

const dynamic = (): Scenario => {
  const text = store("first");
  const flag = store(true);
  const color = store("red");
  const optional = store<string | null>("set");
  return {
    server: true,
    view: () => (
      <div
        class={() => (flag.value ? "on" : "off")}
        classList={() => ({ extra: flag.value, other: !flag.value })}
        style={() => ({ color: color.value })}
        title={text}
        data-n={() => text.value.length}
        aria-label={optional}
      >
        {text}
        <span>{() => text.value.toUpperCase()}</span>
        {() => (flag.value ? <b class="t">yes {text}</b> : <i>no</i>)}
        <input value={text} checked={flag} />
        <p class="static" title={optional}>
          {() => (flag.value ? [<em>a</em>, "b", <em>{text}</em>] : null)}
        </p>
      </div>
    ),
    steps: [
      () => (text.value = "second"),
      () => (flag.value = false),
      () => (color.value = "blue"),
      () => (optional.value = null),
      () => {
        flag.value = true;
        text.value = "third";
        optional.value = "again";
      },
    ],
  };
};

const handlers = (): Scenario => {
  const clicks = store(0);
  const clicked = event();
  reaction({ on: clicked, run: () => void clicks.value++ });
  const element = ref<HTMLButtonElement>();
  const other = ref<HTMLSpanElement>();
  return {
    view: () => (
      <div>
        <button onClick={clicked} ref={element} class="b">
          press {clicks}
        </button>
        <span ref={other}>{() => (clicks.value > 1 ? "many" : "few")}</span>
      </div>
    ),
    steps: [
      (container) => container.querySelector("button")!.click(),
      (container) => container.querySelector("button")!.click(),
    ],
    probe: (container) => [
      element.value === container.querySelector("button"),
      other.value === container.querySelector("span"),
    ],
  };
};

const components = (): Scenario => {
  const ids: string[] = [];
  const shown = store(true);
  const Leaf = (props: { label: string }) => {
    ids.push(`${props.label}:${contextualElementId("leaf")}`);
    return <em data-label={props.label}>{props.label}</em>;
  };
  const Wrapper = (props: { children?: Child }) => {
    ids.push(`wrapper:${contextualElementId("wrapper")}`);
    return (
      <div class="wrapper">
        <Leaf label="in-wrapper" />
        {props.children}
      </div>
    );
  };
  return {
    server: true,
    view: () => (
      <main>
        <Leaf label="first" />
        <section>
          <Leaf label="only" />
        </section>
        <section>
          text
          <Leaf label="second" />
          <b>
            <Leaf label="deep" />
          </b>
        </section>
        <Wrapper>
          <p>
            <Leaf label="child" />
          </p>
        </Wrapper>
        {() => (shown.value ? <Leaf label="dynamic" /> : null)}
        <ul>{[<Leaf label="array-0" />, <li>static</li>, <Leaf label="array-2" />]}</ul>
      </main>
    ),
    steps: [() => (shown.value = false), () => (shown.value = true)],
    probe: () => ids.slice(),
  };
};

const lists = (): Scenario => {
  const items = mutableStore(["a", "b", "c"]);
  return {
    server: true,
    view: () => (
      <table>
        <tbody>
          <For
            each={items}
            view={(item: Readable<string>) => (
              <tr class="row">
                <td>{item}</td>
                <td>
                  <a href="#">x</a>
                </td>
              </tr>
            )}
          />
        </tbody>
      </table>
    ),
    steps: [
      () => items.value.push("d"),
      () => items.value.reverse(),
      () => items.value.splice(1, 2, "e"),
      () => (items.value.length = 0),
      () => items.value.push("f", "g"),
    ],
  };
};

const models = (): Scenario => {
  const log: string[] = [];
  let rows: any[] = [];
  const Row = staticModel({
    name: "TemplateRow",
    with: [ui],
    data: { label: f.string(""), selected: f.boolean(false) },
    setup(self) {
      reaction({ on: self.unmounted, run: () => void log.push(`unmounted ${self.label.value}`) });
      const select = action(() => {
        self.selected.value = !self.selected.value;
      });
      return { select };
    },
  });
  const View = component({
    model: Row,
    view: (_props, self) => (
      <tr class={() => (self.model.selected.value ? "danger" : "")}>
        <td class="col-md-1">{self.model.id}</td>
        <td class="col-md-4">
          <a onClick={self.model.select}>{self.model.label}</a>
        </td>
        <td class="col-md-1">
          <a>
            <span class="glyphicon glyphicon-remove" aria-hidden="true" />
          </a>
        </td>
        <td class="col-md-6" />
      </tr>
    ),
  });
  return {
    view: () => (
      <table class="table">
        <tbody>
          <For each={Row} view={View} />
        </tbody>
      </table>
    ),
    steps: [
      () => {
        rows = Row.create(["1", "2", "3"].map((id) => ({ id, label: `row ${id}` })));
      },
      (container) => (container.querySelectorAll("a")[2] as HTMLElement).click(),
      () => (rows[0].label.value = "changed"),
      () => Row.instances.remove("2"),
      () => Row.instances.remove(),
    ],
    probe: () => log.slice(),
  };
};

const selects = (): Scenario => {
  const value = store("b");
  const options = mutableStore(["a", "b", "c"]);
  const extra = store(false);
  return {
    view: () => (
      <form>
        <select value={value}>
          <option value="a">A</option>
          <For
            each={options}
            view={(option: Readable<string>) => <option value={option}>{option}</option>}
          />
          {() => (extra.value ? <option value="z">Z</option> : null)}
        </select>
        <select>
          <option>x</option>
          <option selected>y</option>
        </select>
      </form>
    ),
    steps: [
      () => (value.value = "c"),
      () => options.value.push("d"),
      () => (value.value = "d"),
      () => (value.value = "z"),
      () => (extra.value = true),
    ],
    probe: (container) => [...container.querySelectorAll("select")].map((select) => select.value),
  };
};

const inspected = (): Scenario => {
  const seen: string[] = [];
  const Inspect = (props: { children?: Child }) => {
    const child = props.children as { type: string; props: Record<string, unknown> };
    seen.push(`${child.type}:${Object.keys(child.props).join(",")}`);
    return [props.children, props.children];
  };
  const text = store("t");
  return {
    server: true,
    view: () => (
      <div>
        <Inspect>
          <p class="inspected" title={text}>
            read <b>{text}</b>
          </p>
        </Inspect>
      </div>
    ),
    steps: [() => (text.value = "u")],
    probe: () => seen.slice(),
  };
};

const vectors = (): Scenario => {
  const width = store(1);
  const label = store("svg");
  return {
    view: () => (
      <svg viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="5" strokeWidth={width} class={() => `c${width.value}`} />
        {() =>
          width.value > 1 ? <rect width="2" height="2" /> : <line x1="0" y1="0" x2="1" y2="1" />
        }
        <foreignObject width="10" height="10">
          <span>{label}</span>
        </foreignObject>
      </svg>
    ),
    steps: [() => (width.value = 2), () => (label.value = "changed"), () => (width.value = 1)],
  };
};

// The SID namespace each binding reads in: the frame of the element (or array
// position) the element-by-element path mounts it in, when first read and on
// every update.
const frames = (): Scenario => {
  const seen: string[] = [];
  const count = store(0);
  const probe = (name: string) =>
    computed(() => {
      seen.push(`${name} ${resolveStoreSid("probe")}`);
      return `${name}${count.value}`;
    });
  const only = probe("only");
  const several = probe("several");
  const attribute = probe("attribute");
  const className = probe("class");
  const deep = probe("deep");
  const title = probe("title");
  const last = probe("last");
  return {
    server: true,
    view: () => (
      <div class={className} data-x={attribute}>
        <p>{only}</p>
        <section>
          head
          {several}
          <b>
            <i>{deep}</i>
          </b>
        </section>
        <ul>
          <li title={title}>x</li>
        </ul>
        {last}
      </div>
    ),
    steps: [() => (count.value = 1), () => (count.value = 2)],
    probe: () => seen.slice(),
  };
};

// `self.model.<member>` holes, which compiled views bind without the member's
// facade: fields, computeds and events, in single and several-children
// positions and attributes, beside members that are no units, the generic
// attribute path (a style) and structured values.
const members = (): Scenario => {
  const seen: string[] = [];
  const Item = staticModel({
    name: "TemplateMember",
    with: [ui],
    data: { label: f.string(""), done: f.boolean(false), count: f.number(0) },
    setup(self) {
      const state = computed(() => {
        seen.push(`state ${self.label.value} ${resolveStoreSid("probe")}`);
        return self.done.value ? "done" : "open";
      });
      const parts = computed(() => [self.label.value, "!"]);
      const toggle = event();
      reaction({
        on: toggle,
        run: () => {
          self.done.value = !self.done.value;
        },
      });
      const bump = action(() => {
        self.count.value++;
      });
      const note = () => {
        seen.push(`note ${self.label.value}`);
        return `${self.label.value}?`;
      };
      return { state, parts, toggle, bump, note, tag: "item" };
    },
  });
  const View = component({
    model: Item,
    view: (_props, self) => (
      <li class={self.model.state} title={self.model.label} data-count={self.model.count}>
        <b>{self.model.label}</b>
        <span>
          {self.model.tag}: {self.model.count} of {self.model.state}
        </span>
        <p>{self.model.parts}</p>
        <button onClick={self.model.toggle}>toggle</button>
        <button onClick={self.model.bump}>bump</button>
        <button onClick={self.model.toggle}>{self.model.done}</button>
        <em>{self.model.note}</em>
        <i style={{ color: "red" }} title={self.model.state}>
          {self.model.id}
        </i>
      </li>
    ),
  });
  const items = Item.create([
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ]);
  return {
    server: true,
    view: () => (
      <ul>
        <For each={Item} view={View} />
      </ul>
    ),
    steps: [
      (container) => container.querySelectorAll("button")[0]!.click(),
      (container) => container.querySelectorAll("button")[4]!.click(),
      (container) => container.querySelectorAll("button")[5]!.click(),
      () => (items[0]!.label.value = "changed"),
      () => Item.create({ id: "c", label: "C" }),
      () => Item.instances.remove("b"),
      () => Item.instances.remove(),
    ],
    probe: () => seen.slice(),
  };
};

export default {
  members,
  frames,
  statics,
  foreign,
  dynamic,
  handlers,
  components,
  lists,
  models,
  selects,
  inspected,
  vectors,
};

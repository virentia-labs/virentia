import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { scope, scoped, store } from "@virentia/core";
import compiler from "../compiler/index";
import * as ui from "../lib/runtime";
import type { ElementDescriptor } from "../lib/types";

// Babel 7 ships its AST declarations separately, but not declarations for core.
const { transformSync } = createRequire(import.meta.url)("@babel/core");

function transform(source: string, options: Record<string, unknown> = {}) {
  return transformSync(source, {
    filename: "example.tsx",
    configFile: false,
    babelrc: false,
    parserOpts: { allowReturnOutsideFunction: true },
    plugins: [compiler],
    ...options,
  }).code as string;
}

interface Description {
  type: unknown;
  props: Record<string, unknown> | null;
  children: unknown[];
}

function execute<Result = Description>(
  source: string,
  bindings: Record<string, unknown> = {},
  runtimeOverride?: Record<string, unknown>,
) {
  const runtime = {
    Fragment: Symbol("Fragment"),
    Show: Symbol("Show"),
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
      return { type, props, children };
    },
    mergeProps: vi.fn((...sources: unknown[]) => ({ sources })),
  };
  const code = transform(source);
  // Replace only the compiler's runtime import for in-memory execution.
  const executable = transformSync(code, {
    configFile: false,
    babelrc: false,
    parserOpts: { allowReturnOutsideFunction: true },
    plugins: [
      ({ types: t }: any) => ({
        visitor: {
          ImportDeclaration(path: any) {
            path.replaceWith(
              t.variableDeclaration("const", [
                t.variableDeclarator(
                  t.objectPattern(
                    path.node.specifiers.map((specifier: any) =>
                      t.objectProperty(specifier.imported, specifier.local),
                    ),
                  ),
                  t.identifier("runtime"),
                ),
              ]),
            );
          },
        },
      }),
    ],
  }).code;
  const result = new Function("runtime", "bindings", executable)(
    runtimeOverride ?? runtime,
    bindings,
  ) as Result;
  return { result, runtime, code };
}

describe("JSX compiler", () => {
  it("defers reactive reads in attributes and text while preserving event/ref callbacks", () => {
    const state = { value: 1 };
    const onClick = vi.fn();
    const ref = vi.fn();
    const { result } = execute(
      `const { state, onClick, ref } = bindings;
       return <button title={state.value} disabled onClick={onClick} ref={ref}>{state.value}</button>;`,
      { state, onClick, ref },
    );

    expect(result.type).toBe("button");
    expect(Object.getOwnPropertyDescriptor(result.props, "title")?.get).toBeTypeOf("function");
    expect(result.props?.title).toBe(1);
    expect(result.props?.disabled).toBe(true);
    expect(result.props?.onClick).toBe(onClick);
    expect(result.props?.ref).toBe(ref);
    expect((result.children[0] as () => number)()).toBe(1);
    state.value = 2;
    expect(result.props?.title).toBe(2);
    expect((result.children[0] as () => number)()).toBe(2);
    expect(onClick).not.toHaveBeenCalled();
    expect(ref).not.toHaveBeenCalled();
  });

  it("keeps component props live and supports member-expression components", () => {
    const Child = vi.fn();
    const state = { value: "first" };
    const { result } = execute(
      `const { UI, state } = bindings; return <UI.Child value={state.value} />;`,
      { UI: { Child }, state },
    );
    expect(result.type).toBe(Child);
    expect(Child).not.toHaveBeenCalled();
    state.value = "second";
    expect(result.props?.value).toBe("second");
  });

  it("defers conditional branches and mapped children", () => {
    const state = { visible: false, items: ["one"] };
    const read = vi.fn();
    const { result, runtime } = execute(
      `const { state, read } = bindings;
       return <main>{state.visible ? <span>{read()}</span> : null}
         {state.items.map(item => <b>{item}</b>)}
       </main>;`,
      { state, read },
    );
    const branch = result.children[0] as Description;
    const list = result.children[1] as () => Description[];
    expect(branch.type).toBe(runtime.Show);
    expect(branch.props?.when).toBe(false);
    expect((branch.props!.fallback as () => null)()).toBeNull();
    expect(read).not.toHaveBeenCalled();
    state.visible = true;
    expect(branch.props?.when).toBe(true);
    expect((branch.children[0] as () => Description)().type).toBe("span");
    expect(read).not.toHaveBeenCalled();
    state.items = ["two", "three"];
    expect(list().map((item) => (item.children[0] as () => string)())).toEqual(["two", "three"]);
  });

  it("preserves render-prop callbacks as functions with their arguments", () => {
    const For = () => null;
    const { result } = execute(
      `const { For } = bindings; return <For each={[1]}>{(item, index) => <span>{item}:{index}</span>}</For>;`,
      { For },
    );
    const row = (result.children[0] as (item: string, index: number) => Description)("row", 3);
    expect((row.children[0] as () => string)()).toBe("row");
    expect((row.children[2] as () => number)()).toBe(3);
  });

  it("passes spread sources lazily in JSX precedence order", () => {
    const state = { props: { title: "initial" }, label: "label" };
    const { runtime } = execute(
      `const { state } = bindings;
       return <div before="first" {...state.props} title={state.label} {...{ last: true }} />;`,
      { state },
    );
    const sources = runtime.mergeProps.mock.calls[0] as [
      Record<string, unknown>,
      () => Record<string, unknown>,
      Record<string, unknown>,
      () => Record<string, unknown>,
    ];
    expect(sources[0]).toEqual({ before: "first" });
    expect(sources[1]()).toBe(state.props);
    expect(sources[2].title).toBe("label");
    expect(sources[3]()).toEqual({ last: true });
    state.props = { title: "replacement" };
    state.label = "changed";
    expect(sources[1]()).toBe(state.props);
    expect(sources[2].title).toBe("changed");
  });

  it("supports fragments, SVG namespaces and JSX whitespace", () => {
    const { result, runtime } = execute(`return <>
      <svg><use xlink:href="#icon" aria-hidden="true" /></svg>
      <p>
        hello
        world <b>!</b>
      </p>
    </>;`);
    expect(result.type).toBe(runtime.Fragment);
    expect(result.children).toHaveLength(2);
    const svg = result.children[0] as Description;
    expect((svg.children[0] as Description).props).toEqual({
      "xlink:href": "#icon",
      "aria-hidden": "true",
    });
    expect((result.children[1] as Description).children[0]).toBe("hello world ");
  });

  it("supports TSX syntax without taking over TypeScript type erasure", () => {
    const code = transform(
      `type Props = { value: number }; const View = (props: Props) => <div>{props.value}</div>;`,
      { parserOpts: { plugins: ["typescript"] } },
    );
    expect(code).toContain("type Props");
    expect(code).toContain("props: Props");
    expect(code).toContain("() => props.value");
    expect(code).not.toContain("<div>");
  });

  it("rejects suspension in reactive expressions but allows async callbacks", () => {
    expect(() => transform("async function View() { return <div>{await load()}</div>; }")).toThrow(
      "await/yield inside reactive JSX expressions",
    );
    expect(() =>
      transform("async function View() { return <div title={await load()} />; }"),
    ).toThrow("await/yield inside reactive JSX expressions");
    expect(() => transform("async function View() { return <div {...await load()} />; }")).toThrow(
      "await/yield inside reactive JSX expressions",
    );
    expect(() => transform("function* View() { return <div>{yield 1}</div>; }")).toThrow(
      "await/yield inside reactive JSX expressions",
    );
    expect(transform("const view = <button onClick={async () => await save()} />;")).toContain(
      "async () => await save()",
    );
  });

  it("imports only needed helpers, supports importSource, and avoids local name collisions", () => {
    expect(transform("const value = 1;")).not.toContain("@virentia/ui");
    const code = transform("const _createElement = 1; const view = <div />;", {
      plugins: [[compiler, { importSource: "custom-ui" }]],
    });
    expect(code).toContain('from "custom-ui"');
    expect(code).toMatch(/createElement as _createElement\d/);
    expect(code).not.toContain("mergeProps");
    expect(code).not.toContain("Fragment");
  });

  it("updates compiled JSX in place without calling parent or child components again", () => {
    const count = store("initial");
    const appScope = scope();
    const calls = { parent: 0, child: 0 };
    const { result } = execute<ElementDescriptor>(
      `const { count, calls } = bindings;
       function Child(props) {
         calls.child++;
         return <span title={props.value}>{props.value}</span>;
       }
       function App() {
         calls.parent++;
         return <section>
           <input value={count.value} onInput={event => count.value = event.currentTarget.value} />
           <Child value={count.value} />
         </section>;
       }
       return <App />;`,
      { count, calls },
      ui,
    );
    const container = document.createElement("div");
    const dispose = ui.render(() => result, container, { scope: appScope });
    try {
      const input = container.querySelector("input")!;
      const span = container.querySelector("span")!;
      const text = Array.from(span.childNodes).find((node) => node.nodeType === 3);
      expect(input.value).toBe("initial");
      expect(span.textContent).toBe("initial");

      scoped(appScope, () => {
        count.value = "changed";
      });
      expect(container.querySelector("input")).toBe(input);
      expect(container.querySelector("span")).toBe(span);
      expect(Array.from(span.childNodes).find((node) => node.nodeType === 3)).toBe(text);
      expect(input.value).toBe("changed");
      expect(span.title).toBe("changed");
      expect(span.textContent).toBe("changed");
      expect(calls).toEqual({ parent: 1, child: 1 });

      input.value = "from event";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(span.textContent).toBe("from event");
      expect(scoped(appScope, () => count.value)).toBe("from event");
      expect(calls).toEqual({ parent: 1, child: 1 });
    } finally {
      dispose();
    }
    expect(container.childNodes).toHaveLength(0);
  });

  it("keeps compiled spread attributes and event-handler replacements reactive", () => {
    const first = vi.fn();
    const second = vi.fn();
    const attributes = store<Record<string, string>>({ title: "first", "data-id": "one" });
    const handlers = store({ onClick: first });
    const appScope = scope();
    const { result } = execute<ElementDescriptor>(
      `const { attributes, handlers } = bindings;
       return <button {...attributes.value} onClick={handlers.value.onClick}>click</button>;`,
      { attributes, handlers },
      ui,
    );
    const container = document.createElement("div");
    const dispose = ui.render(() => result, container, { scope: appScope });
    try {
      const button = container.querySelector("button")!;
      button.click();
      expect(first).toHaveBeenCalledTimes(1);

      scoped(appScope, () => {
        attributes.value = { title: "second" };
        handlers.value = { onClick: second };
      });
      expect(container.querySelector("button")).toBe(button);
      expect(button.title).toBe("second");
      expect(button.hasAttribute("data-id")).toBe(false);
      button.click();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it("preserves conditional branch identity until truthiness changes", () => {
    const count = store(1);
    const appScope = scope();
    const calls = { mount: 0, cleanup: 0 };
    const { result } = execute<ElementDescriptor>(
      `const { count, calls, onUnmount } = bindings;
       function Active() {
         calls.mount++;
         onUnmount(() => calls.cleanup++);
         return <input value={count.value} />;
       }
       return <main>{count.value > 0 ? <Active /> : <span>{count.value}</span>}</main>;`,
      { count, calls, onUnmount: ui.onUnmount },
      ui,
    );
    const container = document.createElement("div");
    const dispose = ui.render(() => result, container, { scope: appScope });
    try {
      const input = container.querySelector("input")!;
      expect(input.value).toBe("1");
      scoped(appScope, () => {
        count.value = 2;
      });
      expect(container.querySelector("input")).toBe(input);
      expect(input.value).toBe("2");
      expect(calls).toEqual({ mount: 1, cleanup: 0 });

      scoped(appScope, () => {
        count.value = 0;
      });
      const fallback = container.querySelector("span")!;
      expect(container.querySelector("input")).toBeNull();
      expect(fallback.textContent).toBe("0");
      expect(calls).toEqual({ mount: 1, cleanup: 1 });
      scoped(appScope, () => {
        count.value = -1;
      });
      expect(container.querySelector("span")).toBe(fallback);
      expect(fallback.textContent).toBe("-1");

      scoped(appScope, () => {
        count.value = 3;
      });
      expect(container.querySelector("input")).not.toBe(input);
      expect(calls).toEqual({ mount: 2, cleanup: 1 });
    } finally {
      dispose();
    }
    expect(calls.cleanup).toBe(2);
  });

  it("preserves nested conditional laziness and JavaScript truthiness for function conditions", () => {
    const truthyFunction = vi.fn(() => false);
    const state = store({ outer: true, inner: true, value: "a" });
    const readInactive = vi.fn(() => "inactive");
    const appScope = scope();
    const { result } = execute<ElementDescriptor>(
      `const { truthyFunction, state, readInactive } = bindings;
       return <main>{truthyFunction
         ? state.value.outer
           ? state.value.inner ? <span>{state.value.value}</span> : <b>other</b>
           : readInactive()
         : "wrong"}</main>;`,
      { truthyFunction, state, readInactive },
      ui,
    );
    const container = document.createElement("div");
    const dispose = ui.render(() => result, container, { scope: appScope });
    try {
      const span = container.querySelector("span")!;
      expect(span.textContent).toBe("a");
      expect(truthyFunction).not.toHaveBeenCalled();
      expect(readInactive).not.toHaveBeenCalled();
      scoped(appScope, () => {
        state.value = { outer: true, inner: true, value: "b" };
      });
      expect(container.querySelector("span")).toBe(span);
      expect(span.textContent).toBe("b");
      scoped(appScope, () => {
        state.value = { outer: true, inner: false, value: "b" };
      });
      expect(container.querySelector("b")?.textContent).toBe("other");
      expect(readInactive).not.toHaveBeenCalled();
      scoped(appScope, () => {
        state.value = { outer: false, inner: false, value: "b" };
      });
      expect(container.textContent).toBe("inactive");
      expect(readInactive).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it("preserves && branch identity and the original falsy child value", () => {
    const truthyFunction = vi.fn(() => false);
    const condition = store<number | null | false | (() => boolean)>(1);
    const calls = { mount: 0, cleanup: 0 };
    const appScope = scope();
    const { result } = execute<ElementDescriptor>(
      `const { condition, calls, onUnmount } = bindings;
       function Child() {
         calls.mount++;
         onUnmount(() => calls.cleanup++);
         return <input />;
       }
       return <main>{condition.value && <Child />}</main>;`,
      { condition, calls, onUnmount: ui.onUnmount },
      ui,
    );
    const container = document.createElement("div");
    const dispose = ui.render(() => result, container, { scope: appScope });
    try {
      const input = container.querySelector("input")!;
      input.value = "unsaved draft";
      scoped(appScope, () => {
        condition.value = 2;
      });
      expect(container.querySelector("input")).toBe(input);
      expect(input.value).toBe("unsaved draft");
      expect(calls).toEqual({ mount: 1, cleanup: 0 });

      scoped(appScope, () => {
        condition.value = 0;
      });
      expect(container.querySelector("input")).toBeNull();
      expect(container.textContent).toBe("0");
      expect(calls).toEqual({ mount: 1, cleanup: 1 });
      scoped(appScope, () => {
        condition.value = null;
      });
      expect(container.textContent).toBe("");
      scoped(appScope, () => {
        condition.value = false;
      });
      expect(container.textContent).toBe("");

      scoped(appScope, () => {
        condition.value = truthyFunction;
      });
      const nextInput = container.querySelector("input")!;
      expect(nextInput).not.toBe(input);
      expect(truthyFunction).not.toHaveBeenCalled();
      expect(calls).toEqual({ mount: 2, cleanup: 1 });
      scoped(appScope, () => {
        condition.value = 3;
      });
      expect(container.querySelector("input")).toBe(nextInput);
      expect(calls).toEqual({ mount: 2, cleanup: 1 });
    } finally {
      dispose();
    }
    expect(calls.cleanup).toBe(2);
  });

  it("keeps nested && branches lazy and updates a falsy fallback independently", () => {
    const state = store({ outer: true, inner: 0 });
    const read = vi.fn(() => "active");
    const appScope = scope();
    const { result } = execute<ElementDescriptor>(
      `const { state, read } = bindings;
       return <main>{state.value.outer && (state.value.inner && <span>{read()}</span>)}</main>;`,
      { state, read },
      ui,
    );
    const container = document.createElement("div");
    const dispose = ui.render(() => result, container, { scope: appScope });
    try {
      expect(container.textContent).toBe("0");
      expect(read).not.toHaveBeenCalled();
      scoped(appScope, () => {
        state.value = { outer: true, inner: 1 };
      });
      const span = container.querySelector("span")!;
      expect(span.textContent).toBe("active");
      expect(read).toHaveBeenCalledTimes(1);
      scoped(appScope, () => {
        state.value = { outer: true, inner: 2 };
      });
      expect(container.querySelector("span")).toBe(span);
      expect(read).toHaveBeenCalledTimes(1);
      scoped(appScope, () => {
        state.value = { outer: false, inner: 2 };
      });
      expect(container.textContent).toBe("");
    } finally {
      dispose();
    }
  });
});

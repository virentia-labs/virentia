// Compiled templates (see "Compiled templates" in lib/runtime.ts). A JSX
// subtree of native elements becomes a blueprint of everything static in it,
// and the JSX element a call with the values of its dynamic places ("holes").
// The holes stay where they were written, in the order the JSX runtime
// evaluates them: an element's attributes, then its children. Whatever the
// runtime could not mount exactly like the JSX runtime's descriptions stays
// JSX and becomes a hole of its own.
//
// Each template is created where it is first used and kept in a module-level
// `var`: a function of the module may run before the module's own body does
// (an import cycle calling it), when a `const` would still be uninitialized.

import { cleanJSXText, decodeJSXEntities } from "./jsx-text";
import type { SourceEdits } from "@virentia/core/compiler/vite";

/** An ESTree node of oxc's parser. */
export interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: any;
}

export interface TemplateOptions {
  /** The module that exports `jsxTemplate` and `jsxFromTemplate`. */
  runtime?: string;
}

/**
 * Elements a template never contains: the runtime mounts them with steps of
 * their own (selection, raw text), or their DOM acts on its own once built
 * (media loading), or they upgrade (custom elements, `is`).
 */
const excludedTags = new Set([
  "audio",
  "embed",
  "iframe",
  "object",
  "script",
  "select",
  "style",
  "template",
  "textarea",
  "title",
  "video",
]);
const voidTags = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" "),
);
/** Props the JSX runtime treats specially, or that the runtime refuses at mount. */
const unsupportedProps = new Set([
  "__proto__",
  "children",
  "dangerouslySetInnerHTML",
  "innerHTML",
  "is",
  "key",
  "textContent",
]);
/** Live control properties: always set at mount, as the runtime sets them. */
const propertyKeys = new Set([
  "checked",
  "defaultChecked",
  "defaultValue",
  "indeterminate",
  "selected",
  "value",
]);
/** Attributes whose effect depends on being set after the element is inserted. */
const insertionSensitive = new Set(["autofocus"]);

const baked = 0;
const atMount = 1;
const hole = 2;

interface Hole {
  readonly start: number;
  readonly end: number;
  /** A sequence expression needs parentheses to stay one array element. */
  readonly sequence: boolean;
  /** Where to look for JSX nested in the hole. */
  readonly node: Node;
  /** `<object>.model.<name>`: a view's model member, which can bind directly. */
  readonly member?: { readonly object: string; readonly name: string };
}

/**
 * `self.model.label` (an identifier's `model`, then a named member): what a
 * component's view writes for a member of its model. Compiled as
 * `jsxMember(self, "label")`, which evaluates to the member itself unless the
 * runtime can bind it directly (see `jsxMember` in lib/runtime.ts).
 */
function modelMember(expression: Node): Hole["member"] {
  if (expression.type !== "MemberExpression" || expression.computed || expression.optional) return;
  if (expression.property.type !== "Identifier") return;
  const model = expression.object as Node;
  if (model.type !== "MemberExpression" || model.computed || model.optional) return;
  if (model.property.type !== "Identifier" || model.property.name !== "model") return;
  if (model.object.type !== "Identifier") return;
  return { object: model.object.name, name: expression.property.name };
}

type Value = { readonly literal: unknown } | { readonly hole: number };

/**
 * Add the edits that compile every eligible JSX subtree of `program`.
 * Returns the number of templates.
 */
export function addTemplateEdits(
  program: Node,
  source: string,
  edits: SourceEdits,
  options: TemplateOptions = {},
): number {
  let prefix = "_vt$";
  while (source.includes(prefix)) prefix += "$";
  const declarations: string[] = [];
  let members = false;

  const literalOf = (expression: Node): { literal: unknown } | undefined => {
    if (expression.type === "Literal") {
      if (expression.regex != null || expression.bigint != null) return undefined;
      const value = expression.value;
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      )
        return { literal: value };
      return undefined;
    }
    if (expression.type === "TemplateLiteral" && expression.expressions.length === 0) {
      const cooked = expression.quasis[0].value.cooked;
      return typeof cooked === "string" ? { literal: cooked } : undefined;
    }
    return undefined;
  };

  const compile = (root: Node, parent: Node | undefined) => {
    const holes: Hole[] = [];
    const addHole = (
      start: number,
      end: number,
      node: Node,
      sequence = false,
      member?: Hole["member"],
    ): number => holes.push({ start, end, node, sequence, member }) - 1;
    const containerHole = (container: Node): number =>
      addHole(
        container.start + 1,
        container.end - 1,
        container.expression,
        container.expression.type === "SequenceExpression",
        modelMember(container.expression),
      );

    const element = (node: Node): string => {
      const opening = node.openingElement;
      const tag: string = opening.name.name;
      // Values first, in source order, so hole indices follow evaluation order.
      const props: { name: string; value: Value }[] = [];
      for (const attribute of opening.attributes) {
        const name = attributeName(attribute.name);
        const value = attribute.value as Node | null;
        let entry: Value;
        if (value === null) entry = { literal: true };
        else if (value.type === "Literal") entry = { literal: decodeJSXEntities(value.value) };
        else if (value.type === "JSXExpressionContainer")
          entry = literalOf(value.expression) ?? { hole: containerHole(value) };
        else entry = { hole: addHole(value.start, value.end, value) };
        props.push({ name, value: entry });
      }
      // What the runtime sets before anything else may be built into the DOM:
      // a prefix of the attributes, so their order on the element is kept.
      // Handlers and refs set no attribute; the class group counts once.
      const classGroupStatic =
        !props.some((prop) => prop.name === "classList") &&
        props.every((prop) => !isClassKey(prop.name) || "literal" in prop.value);
      let leading = true;
      let classGroup: number | undefined;
      const attributes = props.map(({ name, value }) => {
        const fixed = "literal" in value;
        const late = fixed ? atMount : hole;
        let kind: number;
        if (name === "ref" || name.startsWith("on")) kind = late;
        else if (isClassKey(name)) {
          if (classGroup === undefined) {
            classGroup = classGroupStatic && leading ? baked : atMount;
            if (classGroup !== baked) leading = false;
          }
          kind = classGroup === baked ? baked : late;
        } else if (fixed && leading && bakeable(name, (value as { literal: unknown }).literal))
          kind = baked;
        else {
          kind = late;
          leading = false;
        }
        const payload = fixed
          ? JSON.stringify((value as { literal: unknown }).literal)
          : String((value as { hole: number }).hole);
        return `[${JSON.stringify(name)},${kind},${payload}]`;
      });

      const children: string[] = [];
      for (const child of node.children as Node[]) {
        if (child.type === "JSXText") {
          const text = cleanJSXText(source.slice(child.start, child.end));
          if (text) children.push(JSON.stringify(text));
        } else if (child.type === "JSXExpressionContainer") {
          if (child.expression.type === "JSXEmptyExpression") continue;
          const value = literalOf(child.expression);
          children.push(
            value ? `[0,${JSON.stringify(value.literal)}]` : String(containerHole(child)),
          );
        } else if (child.type === "JSXElement" && eligible(child, source))
          children.push(`[1,${element(child)}]`);
        else children.push(String(addHole(child.start, child.end, child)));
      }
      return `[${JSON.stringify(tag)},${attributes.length ? `[${attributes.join(",")}]` : 0},${
        children.length ? `[${children.join(",")}]` : 0
      }]`;
    };

    const blueprint = element(root);
    const name = `${prefix}${declarations.length + 1}`;
    declarations.push(name);
    let open = "";
    let close = "";
    if (
      parent &&
      (parent.type === "JSXElement" ||
        parent.type === "JSXFragment" ||
        parent.type === "JSXAttribute")
    ) {
      // A child or attribute value of JSX that stays JSX.
      open = "{";
      close = "}";
    } else if (parent?.type === "NewExpression" && parent.callee === root) {
      open = "(";
      close = ")";
    } else if (
      // An identifier right before the element (`return<div/>`) must stay apart.
      /[\p{ID_Continue}$\u200c\u200d]$/u.test(source.slice(Math.max(0, root.start - 2), root.start))
    )
      open = " ";
    const call = `${open}${prefix}from(${name} || (${name} = ${prefix}template(${blueprint}))`;
    if (!holes.length) edits.replace(root.start, root.end, `${call})${close}`);
    else {
      const before = (entry: Hole) => (entry.sequence ? "(" : "");
      const after = (entry: Hole) => (entry.sequence ? ")" : "");
      edits.replace(root.start, holes[0].start, `${call}, [${before(holes[0])}`);
      for (let index = 1; index < holes.length; index++)
        edits.replace(
          holes[index - 1].end,
          holes[index].start,
          `${after(holes[index - 1])}, ${before(holes[index])}`,
        );
      const last = holes[holes.length - 1];
      edits.replace(last.end, root.end, `${after(last)}])${close}`);
    }
    for (const entry of holes) {
      if (entry.member) {
        members = true;
        edits.replace(
          entry.start,
          entry.end,
          `${prefix}member(${entry.member.object}, ${JSON.stringify(entry.member.name)})`,
        );
      } else visit(entry.node, undefined);
    }
  };

  const visit = (node: unknown, parent: Node | undefined): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parent);
      return;
    }
    const current = node as Node;
    if (typeof current.type !== "string") return;
    if (current.type === "JSXElement" && eligible(current, source)) {
      compile(current, parent);
      return;
    }
    for (const key in current) {
      if (key === "type" || key === "start" || key === "end") continue;
      const value = current[key];
      if (value && typeof value === "object") visit(value, current);
    }
  };

  visit(program, undefined);
  if (!declarations.length) return 0;

  const runtime = options.runtime ?? "@virentia/ui/jsx-runtime";
  const header =
    `import { jsxTemplate as ${prefix}template, jsxFromTemplate as ${prefix}from${members ? `, jsxMember as ${prefix}member` : ""} } from ${JSON.stringify(runtime)};\n` +
    `var ${declarations.join(", ")};`;
  // After the directives, or before the first statement so leading comments
  // (pragmas, license headers) stay first.
  const body = program.body as Node[];
  let directives: Node | undefined;
  for (const statement of body) {
    if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string") break;
    directives = statement;
  }
  if (directives) edits.insert(directives.end, `\n${header}`);
  else edits.insert(body[0].start, `${header}\n`);
  return declarations.length;
}

function attributeName(name: Node): string {
  return name.type === "JSXNamespacedName" ? `${name.namespace.name}:${name.name.name}` : name.name;
}

/** A literal the runtime would set as an attribute the element-by-element way. */
function bakeable(name: string, literal: unknown): boolean {
  if (propertyKeys.has(name) || insertionSensitive.has(name.toLowerCase())) return false;
  return name !== "style" || literal === null || typeof literal === "string";
}

function isClassKey(name: string): boolean {
  return name === "class" || name === "className" || name === "classList";
}

/** Whether a JSX element can be part of a template. */
export function eligible(node: Node, source: string): boolean {
  const name = node.openingElement.name;
  if (name.type !== "JSXIdentifier") return false;
  const tag: string = name.name;
  // `<this>` names a component: the value of `this`.
  if (!/^[a-z][A-Za-z0-9]*$/.test(tag) || tag === "this" || excludedTags.has(tag)) return false;
  const seen = new Set<string>();
  for (const attribute of node.openingElement.attributes as Node[]) {
    if (attribute.type !== "JSXAttribute") return false;
    const key = attributeName(attribute.name);
    if (unsupportedProps.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  let content = false;
  for (const child of node.children as Node[]) {
    if (child.type === "JSXSpreadChild") return false;
    if (child.type === "JSXText")
      content ||= cleanJSXText(source.slice(child.start, child.end)) !== "";
    else if (
      child.type !== "JSXExpressionContainer" ||
      child.expression.type !== "JSXEmptyExpression"
    )
      content = true;
  }
  return !(content && voidTags.has(tag));
}

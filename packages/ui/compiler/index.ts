import type * as AST from "@babel/types";
import coreCompiler, { type CompilerOptions as CoreCompilerOptions } from "@virentia/core/compiler";

export interface CompilerOptions extends CoreCompilerOptions {
  /** Runtime module to import generated helpers from. */
  importSource?: string;
}

interface BabelAPI {
  types: typeof AST;
  assertVersion(version: number): void;
}

interface Path<Node extends AST.Node> {
  node: Node;
  scope: {
    generateUidIdentifier(name: string): AST.Identifier;
    getBinding(name: string): { path: { node: AST.Node; parent: AST.Node } } | undefined;
  };
  replaceWith(node: AST.Node): void;
  unshiftContainer(name: "body", nodes: AST.Statement[]): void;
  buildCodeFrameError(message: string): Error;
}

type Helper = "createElement" | "Fragment" | "mergeProps" | "Show";

interface CompilerState {
  opts: CompilerOptions;
  file: { opts: { filename?: string; root?: string; cwd?: string } };
  ui: {
    program: Path<AST.Program>;
    imports: Map<Helper, AST.Identifier>;
  };
}

/**
 * Compile ordinary JSX into lazy DOM descriptions and reactive accessors.
 * Run before another JSX transform, or use this as the only JSX transform.
 * Destructuring props and precomputing values outside JSX still take snapshots;
 * read live props inside JSX, or use a computed value for derived state.
 */
export default function virentiaUI(api: BabelAPI) {
  api.assertVersion(7);
  const t = api.types;

  function assertSynchronous(node: AST.Node): void {
    // Nested callbacks retain their own async/generator context.
    if (t.isFunction(node)) return;
    if (t.isAwaitExpression(node) || t.isYieldExpression(node)) {
      throw new SyntaxError(
        "[@virentia/ui/compiler] await/yield inside reactive JSX expressions is not supported. " +
          "Resolve the value before JSX, or use an async callback.",
      );
    }
    const fields = node as unknown as Record<string, unknown>;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const value = fields[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child) assertSynchronous(child as AST.Node);
      } else if (value) {
        assertSynchronous(value as AST.Node);
      }
    }
  }

  function helper(state: CompilerState, name: Helper): AST.Identifier {
    let identifier = state.ui.imports.get(name);
    if (!identifier) {
      identifier = state.ui.program.scope.generateUidIdentifier(name);
      state.ui.imports.set(name, identifier);
    }
    return t.cloneNode(identifier);
  }

  function tag(name: AST.JSXOpeningElement["name"]): AST.Expression {
    if (t.isJSXMemberExpression(name)) {
      return memberTag(name);
    }
    if (t.isJSXNamespacedName(name)) {
      return t.stringLiteral(`${name.namespace.name}:${name.name.name}`);
    }
    if (name.name === "this") return t.thisExpression();
    return /^[a-z]/.test(name.name) || name.name.includes("-")
      ? t.stringLiteral(name.name)
      : t.identifier(name.name);
  }

  function memberTag(name: AST.JSXMemberExpression): AST.MemberExpression {
    const object = t.isJSXMemberExpression(name.object)
      ? memberTag(name.object)
      : name.object.name === "this"
        ? t.thisExpression()
        : t.identifier(name.object.name);
    return t.memberExpression(object, t.identifier(name.property.name));
  }

  function attributeName(name: AST.JSXAttribute["name"]): string {
    return t.isJSXNamespacedName(name) ? `${name.namespace.name}:${name.name.name}` : name.name;
  }

  function getter(name: string, expression: AST.Expression): AST.ObjectMethod {
    assertSynchronous(expression);
    return t.objectMethod(
      "get",
      t.stringLiteral(name),
      [],
      t.blockStatement([t.returnStatement(expression)]),
    );
  }

  function props(
    attributes: AST.JSXOpeningElement["attributes"],
    state: CompilerState,
  ): AST.Expression {
    const sources: AST.Expression[] = [];
    let properties: (AST.ObjectProperty | AST.ObjectMethod)[] = [];
    let hasSpread = false;

    function flush() {
      if (properties.length) {
        sources.push(t.objectExpression(properties));
        properties = [];
      }
    }

    for (const attribute of attributes) {
      if (t.isJSXSpreadAttribute(attribute)) {
        hasSpread = true;
        flush();
        assertSynchronous(attribute.argument);
        sources.push(t.arrowFunctionExpression([], attribute.argument));
        continue;
      }

      const name = attributeName(attribute.name);
      const value = attribute.value;
      if (value === null) {
        properties.push(t.objectProperty(t.stringLiteral(name), t.booleanLiteral(true)));
      } else if (t.isStringLiteral(value)) {
        properties.push(
          t.objectProperty(
            t.stringLiteral(name),
            t.stringLiteral(value.value.replace(/\n\s+/g, " ")),
          ),
        );
      } else {
        const expression = t.isJSXExpressionContainer(value) ? value.expression : value;
        if (!t.isExpression(expression)) continue;
        // A callback-valued getter returns the callback; it never invokes it.
        properties.push(getter(name, expression));
      }
    }
    flush();
    if (hasSpread) return t.callExpression(helper(state, "mergeProps"), sources);
    return sources[0] ?? t.nullLiteral();
  }

  function childExpression(expression: AST.Expression, state: CompilerState): AST.Expression {
    assertSynchronous(expression);
    const conditional = t.isConditionalExpression(expression);
    if (conditional || t.isLogicalExpression(expression, { operator: "&&" })) {
      const test = conditional ? expression.test : expression.left;
      const consequent = conditional ? expression.consequent : expression.right;
      const fallback = conditional
        ? childExpression(expression.alternate, state)
        : t.arrowFunctionExpression([], t.cloneNode(expression.left, true));
      // Each branch owns its subscriptions. Changes that preserve the condition's
      // truthiness update those bindings without remounting the selected branch.
      // An && fallback returns the original falsy value, so 0 still renders as 0.
      return t.callExpression(helper(state, "createElement"), [
        helper(state, "Show"),
        t.objectExpression([
          getter("when", t.unaryExpression("!", t.unaryExpression("!", test))),
          getter("fallback", fallback),
        ]),
        childExpression(consequent, state),
      ]);
    }
    // Preserve render callbacks such as <For>{item => <Row item={item} />}</For>.
    return t.isArrowFunctionExpression(expression) || t.isFunctionExpression(expression)
      ? expression
      : t.arrowFunctionExpression([], expression);
  }

  function children(nodes: AST.JSXElement["children"], state: CompilerState): AST.Expression[] {
    const result: AST.Expression[] = [];
    for (const node of nodes) {
      if (t.isJSXText(node)) {
        const value = cleanText(node.value);
        if (value) result.push(t.stringLiteral(value));
      } else if (t.isJSXExpressionContainer(node) || t.isJSXSpreadChild(node)) {
        const expression = node.expression;
        if (!t.isExpression(expression)) continue;
        result.push(childExpression(expression, state));
      } else if (t.isExpression(node)) {
        // Nested JSX has already been transformed by the exit visitors.
        result.push(node);
      }
    }
    return result;
  }

  return {
    name: "virentia-ui-jsx",
    inherits: coreCompiler,
    manipulateOptions(options: { filename?: string }, parser: { plugins: unknown[] }) {
      if (!/\.[cm]?ts$/.test(options.filename ?? "") && !parser.plugins.includes("jsx")) {
        parser.plugins.push("jsx");
      }
    },
    visitor: {
      Program: {
        enter(path: Path<AST.Program>, state: CompilerState) {
          state.ui = { program: path, imports: new Map() };
        },
        exit(path: Path<AST.Program>, state: CompilerState) {
          if (!state.ui.imports.size) return;
          path.unshiftContainer("body", [
            t.importDeclaration(
              Array.from(state.ui.imports, ([name, identifier]) =>
                t.importSpecifier(identifier, t.identifier(name)),
              ),
              t.stringLiteral(state.opts.importSource ?? "@virentia/ui"),
            ),
          ]);
        },
      },
      JSXElement: {
        exit(path: Path<AST.JSXElement>, state: CompilerState) {
          const node = path.node;
          path.replaceWith(
            t.callExpression(helper(state, "createElement"), [
              tag(node.openingElement.name),
              props(node.openingElement.attributes, state),
              ...children(node.children, state),
            ]),
          );
        },
      },
      JSXFragment: {
        exit(path: Path<AST.JSXFragment>, state: CompilerState) {
          path.replaceWith(
            t.callExpression(helper(state, "createElement"), [
              helper(state, "Fragment"),
              t.nullLiteral(),
              ...children(path.node.children, state),
            ]),
          );
        },
      },
    },
  };
}

// Match the familiar JSX rule: indentation is discarded while meaningful
// whitespace separating text on adjacent lines is kept.
function cleanText(text: string): string {
  const lines = text.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/[^ \t]/.test(lines[i])) lastNonEmpty = i;
  }
  let result = "";
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/\t/g, " ");
    if (i !== 0) line = line.replace(/^ +/, "");
    if (i !== lines.length - 1) line = line.replace(/ +$/, "");
    if (line) result += line + (i !== lastNonEmpty ? " " : "");
  }
  return result;
}

// Automatic SIDs as source edits on an ESTree program from oxc's parser: the
// same SIDs, at the same calls, as the Babel plugin in ./index.ts, without
// regenerating the module. A SID names the call's offset in the original
// source, so these edits must apply to exactly the text that was parsed.

import type { SourceEdits } from "./edits";
import { sidErrors, unitKindOf, unitPackages, type UnitKind } from "./identity";

/** An ESTree node of oxc's parser. */
export interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: any;
}

type Binding = { readonly imported: string } | { readonly namespace: true };

/** Names an inner scope declares, of the names imported from the unit packages. */
interface Shadow {
  readonly names: ReadonlySet<string>;
  readonly parent: Shadow | undefined;
}

/** A compile error at a node, in the shape Vite and Rollup report with a code frame. */
export class SidError extends Error {
  readonly pos: number;
  constructor(message: string, node: Node) {
    super(message);
    this.pos = node.start;
  }
}

/**
 * Add a SID to every unit created through an import of the unit packages.
 * `sourceId` is the module's `sourceIdentity`. Returns the number of SIDs.
 */
export function addSidEdits(program: Node, sourceId: string, edits: SourceEdits): number {
  const imports = new Map<string, Binding>();
  for (const statement of program.body as Node[]) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    if (!unitPackages.has(statement.source.value)) continue;
    for (const specifier of statement.specifiers as Node[]) {
      if (specifier.type === "ImportNamespaceSpecifier")
        imports.set(specifier.local.name, { namespace: true });
      else if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type")
        imports.set(specifier.local.name, {
          imported:
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value,
        });
    }
  }
  if (!imports.size) return 0;

  let count = 0;
  const declare = (names: Set<string>, shadow: Shadow | undefined): Shadow | undefined => {
    for (const name of names) if (!imports.has(name)) names.delete(name);
    return names.size ? { names, parent: shadow } : shadow;
  };

  const unitKind = (call: Node, shadow: Shadow | undefined): UnitKind | undefined => {
    if (call.optional) return undefined;
    const callee = unwrap(call.callee);
    let local: string;
    let imported: string | undefined;
    if (callee.type === "Identifier") {
      local = callee.name;
      const binding = imports.get(local);
      if (!binding || !("imported" in binding)) return undefined;
      imported = binding.imported;
    } else if (callee.type === "MemberExpression" && !callee.optional) {
      const object = unwrap(callee.object);
      if (object.type !== "Identifier") return undefined;
      local = object.name;
      if (!imports.get(local) || !("namespace" in imports.get(local)!)) return undefined;
      const property = unwrap(callee.property as Node);
      imported =
        !callee.computed && property.type === "Identifier"
          ? property.name
          : callee.computed && isString(property)
            ? property.value
            : undefined;
    } else return undefined;
    for (let scope = shadow; scope; scope = scope.parent)
      if (scope.names.has(local)) return undefined;
    return unitKindOf(imported);
  };

  const addSid = (call: Node, kind: UnitKind) => {
    const sid = `sid: ${JSON.stringify(`${sourceId}:${call.start}`)}`;
    // Arguments as written, parentheses included: appended text goes after them.
    const args = call.arguments as Node[];
    // Arguments as Babel sees them, through parentheses.
    const arg = (index: number): Node | undefined => args[index] && unwrap(args[index]);
    const intoObject = (object: Node) => {
      if (hasSid(object)) return;
      // First, so that existing spreads keep their precedence.
      edits.insert(object.start + 1, object.properties.length ? ` ${sid},` : ` ${sid} `);
    };
    const append = (text: string) => {
      if (args.length) edits.insert(args[args.length - 1].end, `, ${text}`);
      else edits.insert(call.end - 1, text);
    };
    if (kind === "store") {
      if (!args.length) return;
      if (args.length > 3 || args.some((entry) => entry.type === "SpreadElement"))
        throw new SidError(sidErrors.storeSpread, call);
      const options = arg(2);
      if (options && options.type !== "ObjectExpression")
        throw new SidError(sidErrors.storeOptions, options);
      if (options) intoObject(options);
      // Preserve an explicit second argument, including `undefined`.
      else if (args.length === 2) append(`{ ${sid}, hasSkipToken: true }`);
      else append(`void 0, { ${sid} }`);
    } else if (kind === "event") {
      if (args.length > 2 || args.some((entry) => entry.type === "SpreadElement"))
        throw new SidError(sidErrors.eventSpread, call);
      if (!args.length) append(`{ ${sid} }`);
      else if (args.length === 1 && arg(0)!.type === "ObjectExpression") intoObject(arg(0)!);
      else {
        // A dynamic first argument may be a name or options: SID metadata goes second.
        const metadata = arg(1);
        if (metadata && metadata.type !== "ObjectExpression")
          throw new SidError(sidErrors.eventMetadata, metadata);
        if (metadata) intoObject(metadata);
        else append(`{ ${sid} }`);
      }
    } else if (kind === "model") {
      const config = arg(0);
      if (!config || config.type !== "ObjectExpression")
        throw new SidError(sidErrors.modelConfig, config ?? call);
      intoObject(config);
    } else {
      const options = arg(1);
      if (options && options.type !== "ObjectExpression")
        throw new SidError(sidErrors.mutableOptions, options);
      if (options) intoObject(options);
      else append(`{ ${sid} }`);
    }
    count++;
  };

  const visitFunction = (node: Node, shadow: Shadow | undefined) => {
    const own = new Set<string>();
    if (node.type === "FunctionExpression" && node.id) own.add(node.id.name);
    for (const param of node.params as Node[]) bindingNames(param, own);
    const names = new Set(own);
    const body = node.body as Node | null;
    if (body?.type === "BlockStatement") {
      varNames(body, names);
      blockNames(body.body, names);
    }
    // Expressions in a parameter pattern do not see the body's declarations.
    // As in Babel, a rest element or TS parameter property is no pattern scope.
    const parameters = declare(own, shadow);
    const inner = declare(names, shadow);
    for (const param of node.params as Node[])
      visit(param, patternScopes.has(param.type) ? parameters : inner);
    if (body?.type === "BlockStatement") for (const statement of body.body) visit(statement, inner);
    else if (body) visit(body, inner);
  };

  const visit = (node: Node | null | undefined, shadow: Shadow | undefined): void => {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        visitFunction(node, shadow);
        return;
      case "BlockStatement":
      case "StaticBlock": {
        const names = blockNames(node.body, new Set());
        // A static block is a function body of its own for `var`.
        if (node.type === "StaticBlock")
          for (const statement of node.body) varNames(statement, names);
        const inner = declare(names, shadow);
        for (const statement of node.body) visit(statement, inner);
        return;
      }
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const head = (node.type === "ForStatement" ? node.init : node.left) as Node | null;
        const names = new Set<string>();
        if (head?.type === "VariableDeclaration" && head.kind !== "var")
          for (const declarator of head.declarations) bindingNames(declarator.id, names);
        const inner = declare(names, shadow);
        visitChildren(node, inner);
        return;
      }
      case "SwitchStatement": {
        visit(node.discriminant, shadow);
        const names = new Set<string>();
        for (const entry of node.cases) blockNames(entry.consequent, names);
        const inner = declare(names, shadow);
        for (const entry of node.cases) visitChildren(entry, inner);
        return;
      }
      case "CatchClause": {
        const names = new Set<string>();
        if (node.param) bindingNames(node.param, names);
        blockNames(node.body.body, names);
        // As in Babel, defaults in the parameter see none of the clause's names.
        visit(node.param, shadow);
        const inner = declare(names, shadow);
        for (const statement of node.body.body) visit(statement, inner);
        return;
      }
      case "ClassExpression":
      case "ClassDeclaration": {
        const names = new Set<string>();
        if (node.type === "ClassExpression" && node.id) names.add(node.id.name);
        // Decorators and the heritage are in the class scope, as in Babel: they
        // see a class expression's own name.
        const inner = declare(names, shadow);
        for (const decorator of node.decorators ?? []) visit(decorator, inner);
        visit(node.superClass, inner);
        visit(node.body, inner);
        return;
      }
      case "TSModuleDeclaration": {
        const body = node.body as Node | null;
        if (body?.type !== "TSModuleBlock") {
          visit(body, shadow);
          return;
        }
        const names = new Set<string>();
        varNames(body, names);
        blockNames(body.body, names);
        const inner = declare(names, shadow);
        for (const statement of body.body) visit(statement, inner);
        return;
      }
      case "CallExpression": {
        const kind = unitKind(node, shadow);
        if (kind) addSid(node, kind);
        break;
      }
    }
    visitChildren(node, shadow);
  };

  const visitChildren = (node: Node, shadow: Shadow | undefined) => {
    for (const key in node) {
      if (skippedKeys.has(key)) continue;
      const value = node[key];
      if (!value || typeof value !== "object") continue;
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === "object") visit(item, shadow);
      } else visit(value, shadow);
    }
  };

  for (const statement of program.body as Node[]) visit(statement, undefined);
  return count;
}

/** Keys that hold no expressions: positions, names and types. */
const skippedKeys = new Set([
  "type",
  "start",
  "end",
  "range",
  "loc",
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeArguments",
]);

/** Parameters Babel gives a scope of their own: see `visitFunction`. */
const patternScopes = new Set(["AssignmentPattern", "ObjectPattern", "ArrayPattern"]);

function unwrap(node: Node): Node {
  while (node.type === "ParenthesizedExpression") node = node.expression;
  return node;
}

function isString(node: Node): boolean {
  return node.type === "Literal" && typeof node.value === "string";
}

function hasSid(object: Node): boolean {
  return (object.properties as Node[]).some((property) => {
    if (property.type !== "Property") return false;
    const key = unwrap(property.key);
    return (
      (!property.computed && key.type === "Identifier" && key.name === "sid") ||
      (isString(key) && key.value === "sid")
    );
  });
}

/** The names a binding pattern declares. */
function bindingNames(pattern: Node | null, names: Set<string>): void {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      names.add(pattern.name);
      return;
    case "ObjectPattern":
      for (const property of pattern.properties)
        bindingNames(property.type === "RestElement" ? property.argument : property.value, names);
      return;
    case "ArrayPattern":
      for (const element of pattern.elements) bindingNames(element, names);
      return;
    case "AssignmentPattern":
      bindingNames(pattern.left, names);
      return;
    case "RestElement":
      bindingNames(pattern.argument, names);
      return;
    case "TSParameterProperty":
      bindingNames(pattern.parameter, names);
      return;
  }
}

/** Lexical declarations of a block's own statements, and its function declarations. */
function blockNames(statements: readonly Node[], names: Set<string>): Set<string> {
  for (let statement of statements) {
    if (
      (statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportDefaultDeclaration") &&
      statement.declaration
    )
      statement = statement.declaration;
    switch (statement.type) {
      case "VariableDeclaration":
        if (statement.kind !== "var")
          for (const declarator of statement.declarations) bindingNames(declarator.id, names);
        break;
      case "FunctionDeclaration":
      case "ClassDeclaration":
      case "TSEnumDeclaration":
        if (statement.id) names.add(statement.id.name);
        break;
      case "TSModuleDeclaration":
        if (statement.id?.type === "Identifier") names.add(statement.id.name);
        break;
      case "TSImportEqualsDeclaration":
        names.add(statement.id.name);
        break;
    }
  }
  return names;
}

/** `var` declarations of a function body, through its blocks but not nested functions. */
function varNames(node: Node | null | undefined, names: Set<string>): void {
  if (!node) return;
  switch (node.type) {
    case "VariableDeclaration":
      if (node.kind === "var")
        for (const declarator of node.declarations) bindingNames(declarator.id, names);
      return;
    case "BlockStatement":
    case "TSModuleBlock":
    case "Program":
      for (const statement of node.body) varNames(statement, names);
      return;
    case "ExportNamedDeclaration":
      varNames(node.declaration, names);
      return;
    case "IfStatement":
      varNames(node.consequent, names);
      varNames(node.alternate, names);
      return;
    case "ForStatement":
      varNames(node.init, names);
      varNames(node.body, names);
      return;
    case "ForInStatement":
    case "ForOfStatement":
      varNames(node.left, names);
      varNames(node.body, names);
      return;
    case "WhileStatement":
    case "DoWhileStatement":
    case "LabeledStatement":
    case "WithStatement":
      varNames(node.body, names);
      return;
    case "TryStatement":
      varNames(node.block, names);
      varNames(node.handler?.body, names);
      varNames(node.finalizer, names);
      return;
    case "SwitchStatement":
      for (const entry of node.cases)
        for (const statement of entry.consequent) varNames(statement, names);
      return;
  }
}

import { posix } from "node:path";
import type * as AST from "@babel/types";

export interface CompilerOptions {
  /** Shared source root for server and client builds. Defaults to Babel's root. */
  root?: string;
  /** Distinguishes applications with the same root-relative source paths. */
  namespace?: string;
  /** Disable automatic SIDs. Enabled by default. */
  sid?: boolean;
}

interface BabelAPI {
  types: typeof AST;
  assertVersion(version: number): void;
}

interface Path<Node extends AST.Node> {
  node: Node;
  scope: {
    getBinding(name: string): { path: { node: AST.Node; parent: AST.Node } } | undefined;
  };
  buildCodeFrameError(message: string): Error;
}

interface CompilerState {
  opts: CompilerOptions;
  file: { opts: { filename?: string; root?: string; cwd?: string } };
  coreSid?: { sourceId?: string };
}

type UnitKind = "store" | "event";

/** Add source-stable SIDs to Virentia store and event declarations. */
export default function virentiaCore(api: BabelAPI) {
  api.assertVersion(7);
  const t = api.types;

  function unitKind(path: Path<AST.CallExpression>): UnitKind | undefined {
    const callee = path.node.callee;
    let local: string;
    let imported: string | undefined;
    let namespace = false;
    if (t.isIdentifier(callee)) {
      local = callee.name;
    } else if (t.isMemberExpression(callee) && t.isIdentifier(callee.object)) {
      local = callee.object.name;
      imported =
        !callee.computed && t.isIdentifier(callee.property)
          ? callee.property.name
          : t.isStringLiteral(callee.property)
            ? callee.property.value
            : undefined;
      namespace = true;
    } else {
      return undefined;
    }

    const binding = path.scope.getBinding(local);
    if (!binding || !t.isImportDeclaration(binding.path.parent)) return undefined;
    const declaration = binding.path.parent;
    if (declaration.importKind === "type") return undefined;
    if (
      declaration.source.value !== "@virentia/core" &&
      declaration.source.value !== "@virentia/ui"
    ) {
      return undefined;
    }

    const specifier = binding.path.node;
    if (namespace) {
      if (!t.isImportNamespaceSpecifier(specifier)) return undefined;
    } else {
      if (!t.isImportSpecifier(specifier) || specifier.importKind === "type") return undefined;
      imported = t.isIdentifier(specifier.imported)
        ? specifier.imported.name
        : specifier.imported.value;
    }
    return imported === "event"
      ? "event"
      : imported === "store" || imported === "reactive" || imported === "readonlyReactive"
        ? "store"
        : undefined;
  }

  function hasSid(options: AST.ObjectExpression): boolean {
    return options.properties.some(
      (property) =>
        !t.isSpreadElement(property) &&
        ((!property.computed && t.isIdentifier(property.key, { name: "sid" })) ||
          t.isStringLiteral(property.key, { value: "sid" })),
    );
  }

  function addSid(options: AST.ObjectExpression, generated: AST.ObjectProperty): void {
    if (!hasSid(options)) {
      // Existing spreads keep rightmost precedence, including an explicit SID.
      options.properties.unshift(generated);
    }
  }

  function storeSid(path: Path<AST.CallExpression>, generated: AST.ObjectProperty): void {
    const args = path.node.arguments;
    if (args.length === 0) return;
    if (args.some((arg) => t.isSpreadElement(arg)) || args.length > 3) {
      throw path.buildCodeFrameError(
        "[@virentia/core/compiler] Automatic store SIDs require explicit arguments (no argument spreads). " +
          "Use store(initial, skipToken, { sid: ... }) or disable automatic SIDs with sid: false.",
      );
    }
    const options = args[2];
    if (options && !t.isObjectExpression(options)) {
      throw path.buildCodeFrameError(
        "[@virentia/core/compiler] Automatic store SIDs require an object literal for the third argument. " +
          "Spread existing options into that object, or disable automatic SIDs with sid: false.",
      );
    }
    if (options) {
      addSid(options, generated);
      return;
    }

    const explicitSkipToken = args.length === 2;
    if (!explicitSkipToken) args.push(t.unaryExpression("void", t.numericLiteral(0)));
    args.push(
      t.objectExpression([
        generated,
        // Preserve an explicit second argument, including `undefined`.
        ...(explicitSkipToken
          ? [t.objectProperty(t.identifier("hasSkipToken"), t.booleanLiteral(true))]
          : []),
      ]),
    );
  }

  function eventSid(path: Path<AST.CallExpression>, generated: AST.ObjectProperty): void {
    const args = path.node.arguments;
    if (args.some((arg) => t.isSpreadElement(arg)) || args.length > 2) {
      throw path.buildCodeFrameError(
        "[@virentia/core/compiler] Automatic event SIDs require explicit arguments (no argument spreads). " +
          "Use event({ sid: ... }) or disable automatic SIDs with sid: false.",
      );
    }
    if (args.length === 0) {
      args.push(t.objectExpression([generated]));
      return;
    }
    if (args.length === 1 && t.isObjectExpression(args[0])) {
      addSid(args[0], generated);
      return;
    }

    // A dynamic first argument may be a name or an options object. A separate
    // metadata argument preserves both cases and lets explicit options win.
    const metadata = args[1];
    if (metadata && !t.isObjectExpression(metadata)) {
      throw path.buildCodeFrameError(
        "[@virentia/core/compiler] Automatic event SIDs require an object literal for the second argument.",
      );
    }
    if (metadata) addSid(metadata, generated);
    else args.push(t.objectExpression([generated]));
  }

  return {
    name: "virentia-core-sid",
    visitor: {
      Program: {
        enter(_path: Path<AST.Program>, state: CompilerState) {
          state.coreSid = { sourceId: sourceIdentity(state) };
        },
      },
      CallExpression(path: Path<AST.CallExpression>, state: CompilerState) {
        const sourceId = state.coreSid?.sourceId;
        if (!sourceId) return;
        const kind = unitKind(path);
        if (!kind) return;
        const location =
          path.node.start ??
          (path.node.loc ? `${path.node.loc.start.line}:${path.node.loc.start.column}` : undefined);
        if (location === undefined) {
          throw path.buildCodeFrameError(
            `[@virentia/core/compiler] Cannot generate a ${kind} SID without a source location.`,
          );
        }
        const generated = t.objectProperty(
          t.identifier("sid"),
          t.stringLiteral(`${sourceId}:${location}`),
        );
        if (kind === "store") storeSid(path, generated);
        else eventSid(path, generated);
      },
    },
  };
}

function sourceIdentity(state: CompilerState): string | undefined {
  if (state.opts.sid === false || !state.file.opts.filename) return undefined;
  const filename = portablePath(state.file.opts.filename);
  let root = portablePath(
    state.opts.root ?? state.file.opts.root ?? state.file.opts.cwd ?? process.cwd(),
  );
  if (!posix.isAbsolute(root) && !/^[a-z]:\//i.test(root)) {
    root = posix.resolve(portablePath(state.file.opts.cwd ?? process.cwd()), root);
  }
  const relative = posix.relative(root, filename);
  return `v1:${encodeURIComponent(state.opts.namespace ?? "")}:${encodeURIComponent(relative)}`;
}

function portablePath(filename: string): string {
  let normalized = filename.replace(/\\/g, "/");
  // Babel on POSIX may prefix a simulated Windows filename with cwd.
  const drive = /(?:^|\/)([a-z]:\/.*)$/i.exec(normalized);
  if (drive) normalized = drive[1][0].toLowerCase() + drive[1].slice(1);
  const unc = /(?:^|\/)(\\\\[^\\]+\\.*)$/.exec(filename);
  if (unc) normalized = unc[1].replace(/\\/g, "/");
  return posix.normalize(normalized);
}

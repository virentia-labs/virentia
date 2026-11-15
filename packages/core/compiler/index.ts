import type * as AST from "@babel/types";
import { sidErrors, sourceIdentity, unitKindOf, unitPackages, type UnitKind } from "./identity";

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
    if (!unitPackages.has(declaration.source.value)) return undefined;

    const specifier = binding.path.node;
    if (namespace) {
      if (!t.isImportNamespaceSpecifier(specifier)) return undefined;
    } else {
      if (!t.isImportSpecifier(specifier) || specifier.importKind === "type") return undefined;
      imported = t.isIdentifier(specifier.imported)
        ? specifier.imported.name
        : specifier.imported.value;
    }
    return unitKindOf(imported);
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
      throw path.buildCodeFrameError(sidErrors.storeSpread);
    }
    const options = args[2];
    if (options && !t.isObjectExpression(options)) {
      throw path.buildCodeFrameError(sidErrors.storeOptions);
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
      throw path.buildCodeFrameError(sidErrors.eventSpread);
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
      throw path.buildCodeFrameError(sidErrors.eventMetadata);
    }
    if (metadata) addSid(metadata, generated);
    else args.push(t.objectExpression([generated]));
  }

  return {
    name: "virentia-core-sid",
    visitor: {
      Program: {
        enter(_path: Path<AST.Program>, state: CompilerState) {
          state.coreSid = { sourceId: sourceIdentityOf(state) };
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
        else if (kind === "event") eventSid(path, generated);
        else if (kind === "model") {
          const config = path.node.arguments[0];
          if (!t.isObjectExpression(config)) throw path.buildCodeFrameError(sidErrors.modelConfig);
          addSid(config, generated);
        } else {
          const options = path.node.arguments[1];
          if (options && !t.isObjectExpression(options))
            throw path.buildCodeFrameError(sidErrors.mutableOptions);
          if (options) addSid(options, generated);
          else path.node.arguments.push(t.objectExpression([generated]));
        }
      },
    },
  };
}

function sourceIdentityOf(state: CompilerState): string | undefined {
  if (state.opts.sid === false || !state.file.opts.filename) return undefined;
  const cwd = state.file.opts.cwd ?? process.cwd();
  return sourceIdentity(
    state.file.opts.filename,
    state.opts.root ?? state.file.opts.root ?? cwd,
    cwd,
    state.opts.namespace,
  );
}

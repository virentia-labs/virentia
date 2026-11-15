import { createRequire } from "node:module";
import compiler, { type CompilerOptions } from "./index";
import { SourceEdits, type SourceMap as EditsSourceMap } from "./edits";
import { sourceIdentity } from "./identity";
import { addSidEdits, SidError, type Node } from "./oxc";
export type { CompilerOptions } from "./index";
export { SourceEdits } from "./edits";
export { sourceIdentity } from "./identity";
export { addSidEdits, SidError } from "./oxc";
export type { Node as EstreeNode } from "./oxc";

interface SourceMap {
  version: number;
  names: string[];
  sources: string[];
  sourcesContent?: (string | null)[];
  mappings: string;
  file?: string;
  sourceRoot?: string;
}

interface TransformResult {
  code: string;
  map: SourceMap | EditsSourceMap | null;
}

interface BabelTransformResult {
  code?: string | null;
  map?: SourceMap | null;
}

interface Babel {
  transformSync(
    source: string,
    options: {
      filename: string;
      sourceFileName: string;
      sourceMaps: true;
      configFile: false;
      babelrc: false;
      parserOpts: { sourceType: "unambiguous"; plugins: string[] };
      plugins: [typeof compiler, CompilerOptions][];
    },
  ): BabelTransformResult | null;
}

/** The part of a Vite 8 (Rolldown) plugin context this plugin uses. */
interface ParseContext {
  meta?: { rolldownVersion?: string };
  parse?(
    code: string,
    options: { lang: "js" | "jsx" | "ts" | "tsx"; sourceType: "unambiguous"; preserveParens: true },
  ): Node;
}

let babel: Babel | undefined;

/** The parser language of a module id, as oxc names it. */
export function languageOf(id: string): "js" | "jsx" | "ts" | "tsx" {
  return /\.[cm]?tsx?$/.test(id) ? (id.endsWith(".tsx") ? "tsx" : "ts") : "jsx";
}

/** Whether a module may create units that take SIDs. */
export function needsSids(source: string, id: string, options: CompilerOptions): boolean {
  return (
    options.sid !== false &&
    /\.[cm]?[jt]sx?$/.test(id) &&
    !/\.d\.[cm]?ts$/.test(id) &&
    !/(?:^|[/\\])node_modules(?:[/\\]|$)/.test(id) &&
    !id.includes("?") &&
    (source.includes("@virentia/core") ||
      source.includes("@virentia/ui") ||
      source.includes("@virentia/mutable"))
  );
}

/** Rethrow a SID error with the location Vite and Rollup print a code frame for. */
export function locatedSidError(error: unknown, source: string, id: string): unknown {
  if (!(error instanceof SidError)) return error;
  const before = source.slice(0, error.pos);
  const line = before.split("\n").length;
  const column = error.pos - before.lastIndexOf("\n") - 1;
  return Object.assign(new Error(`${id}: ${error.message}`), {
    id,
    pos: error.pos,
    loc: { file: id, line, column },
  });
}

/** Give Core stores and events stable SIDs before Vite's regular transforms. */
export default function virentiaCore(options: CompilerOptions = {}) {
  let root = options.root;
  return {
    name: "virentia-core-sid",
    enforce: "pre" as const,
    configResolved(config: { root: string }) {
      root = options.root ?? config.root;
    },
    transform(source: string, id: string): TransformResult | null {
      if (!needsSids(source, id, options)) return null;

      // Vite 8 parses with oxc: SIDs become edits of the source itself.
      const context = this as unknown as ParseContext | undefined;
      if (context?.meta?.rolldownVersion && typeof context.parse === "function") {
        let program: Node;
        try {
          // A parenthesized argument keeps the parentheses' span: SIDs go after them.
          program = context.parse(source, {
            lang: languageOf(id),
            sourceType: "unambiguous",
            preserveParens: true,
          });
        } catch {
          // The module's own transform reports its syntax errors.
          return null;
        }
        const edits = new SourceEdits(source);
        const cwd = process.cwd();
        try {
          addSidEdits(program, sourceIdentity(id, root ?? cwd, cwd, options.namespace), edits);
        } catch (error) {
          throw locatedSidError(error, source, id);
        }
        return edits.changed ? edits.apply(id) : null;
      }

      babel ??= createRequire(import.meta.url)("@babel/core") as Babel;
      const result = babel.transformSync(source, {
        filename: id,
        sourceFileName: id,
        sourceMaps: true,
        configFile: false,
        babelrc: false,
        parserOpts: {
          sourceType: "unambiguous",
          plugins: /\.[cm]?tsx?$/.test(id)
            ? id.endsWith(".tsx")
              ? ["typescript", "jsx"]
              : ["typescript"]
            : ["jsx"],
        },
        plugins: [[compiler, { ...options, root }]],
      });
      if (!result?.code) return null;
      return { code: result.code, map: result.map ?? null };
    },
  };
}
